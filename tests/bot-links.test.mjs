import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BotLinks } from '../host/bot-links.js';
import { createBotLinkSettings, linkConnectionState } from '../host/bot-link-settings.js';
import { ChatDirectory } from '../host/chat-directory.js';
import { readFile } from 'node:fs/promises';

async function fixture(t) {
  const directory = await mkdtemp('/tmp/wechat-bot-links-');
  const listeners = new Set(), sends = [], prompts = [], targets = [
    { kind: 'bot', id: 'chief', name: 'Chief', sessionId: 'chief-part-2' },
    { kind: 'room', id: 'team', name: 'Team', sessionId: 'team-part-3' },
  ];
  const bridge = {
    version: 1, supportsInterrupt: true, targets: async () => targets,
    resolve: async target => { const found = targets.find(row => row.kind === target?.kind && row.id === target?.id); if (!found) throw new Error('not an eligible Main Bot or group'); return found; },
    send: async (target, content) => { await bridge.resolve(target); prompts.push({ target, content }); },
    stop: async () => true,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const options = { ctx: { get: () => bridge }, directory, send: async (...args) => { sends.push(args); return { ok: true }; } };
  const links = new BotLinks(options);
  t.after(async () => { await links.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { links, options, targets, bridge, prompts, sends, listeners, directory };
}

test('bindings persist, separate providers, reject cross-kind targets and stale settings', async t => {
  const f = await fixture(t);
  await assert.rejects(f.links.update({ provider: 'pad', chatId: 'group@chatroom', isGroup: true, target: { kind: 'bot', id: 'chief' }, revision: 0 }), /只能关联/);
  await assert.rejects(f.links.update({ provider: 'pad', chatId: 'person', target: { kind: 'bot', id: 'worker' }, revision: 0 }), /eligible/);
  await f.links.update({ provider: 'pad', chatId: 'person', target: { kind: 'bot', id: 'chief' }, revision: 0 });
  assert.equal(f.links.ordinaryDeliveryAllowed('pad', 'person'), false, 'old ordinary Session output cannot mix into a linked chat');
  assert.equal(f.links.ordinaryDeliveryAllowed('weixin', 'person'), true, 'the other connection retains its own route');
  await assert.rejects(f.links.update({ provider: 'pad', chatId: 'person', target: null, revision: 0 }), /其他窗口/);
  assert.equal(await f.links.binding('weixin', 'person'), null);
  const restored = new BotLinks(f.options);
  assert.equal((await restored.binding('pad', 'person')).target.id, 'chief');
  await restored.dispose();
});

test('messages stay on the linked logical identity and deletion never opens a fallback Session', async t => {
  const f = await fixture(t);
  await f.links.update({ provider: 'pad', chatId: 'group@chatroom', isGroup: true, target: { kind: 'room', id: 'team' }, revision: 0 });
  const binding = await f.links.binding('pad', 'group@chatroom');
  await f.links.receive(binding, { messageId: 'wx-1' }, { text: 'Review it', images: [] });
  assert.equal(f.prompts[0].target.id, 'team');
  f.targets.pop();
  await assert.rejects(f.links.receive(binding, { messageId: 'wx-2' }, { text: 'Again' }), /eligible/);
  assert.equal(f.prompts.length, 1);
  await f.links.update({ ...binding, target: null, revision: 1 });
  await assert.rejects(f.links.receive(binding, {}, { text: 'stale queued message' }), /关联已改变/);
});

test('visible replies fan out only to matching bindings; duplicates and unlinked chats stay quiet', async t => {
  const f = await fixture(t);
  await f.links.update({ provider: 'pad', chatId: 'person', target: { kind: 'bot', id: 'chief' }, revision: 0 });
  f.links.start(); f.links.start();
  assert.equal(f.listeners.size, 1);
  const event = { id: 'part:9', target: { kind: 'bot', id: 'chief' }, text: 'Verified result' };
  for (const listener of f.listeners) { listener(event); listener(event); }
  for (let n = 0; n < 20 && !f.sends.length; n++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, [['pad', 'person', 'Verified result']]);
  await f.links.update({ provider: 'pad', chatId: 'person', target: null, revision: 1 });
  for (const listener of f.listeners) listener({ ...event, id: 'part:10' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sends.length, 1);
  await f.links.dispose();
  assert.equal(f.listeners.size, 0);
});

test('a corrupt binding store is not silently replaced', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'bot-links.json'), '{broken');
  const broken = new BotLinks(f.options);
  await assert.rejects(broken.view(), SyntaxError);
  await assert.rejects(broken.update({ provider: 'pad', chatId: 'person', target: null, revision: 0 }), SyntaxError);
  await broken.dispose();
});

test('the settings facade uses the optional service injection scope and releases it on unload', async t => {
  const f = await fixture(t);
  let release;
  const ctx = { get: () => undefined, inject: (_dependencies, callback) => {
    callback({ get: () => f.bridge, effect: fn => { release = fn(); } });
    return { dispose: async () => release() };
  } };
  const scoped = new BotLinks({ ...f.options, ctx });
  assert.equal((await scoped.view()).available, false);
  scoped.start();
  assert.equal((await scoped.view()).available, true);
  await scoped.dispose();
  assert.equal((await scoped.view()).available, false);
});

test('target settings separate groups and robot users, preserve offline links, and refuse takeover', async t => {
  const f = await fixture(t);
  let connected = true;
  const config = { enabled: true, enabledProviders: ['pad', 'weixin'], baseUrl: 'fixture', token: 'private-fixture-token', wxid: 'fixture-account', dmPolicy: 'disabled', groupPolicy: 'open', groupRequireMention: true };
  const settings = createBotLinkSettings({ links: f.links, config: () => config,
    statuses: () => ({ pad: { connected, phase: connected ? 'connected' : 'error' }, weixin: { connected: true, phase: 'connected' } }),
    chats: async () => [{ provider: 'pad', chatId: 'team@chatroom', label: 'Team' }, { provider: 'weixin', chatId: 'opaque-user', label: 'Robot user' }, { provider: 'pad', chatId: 'person', label: 'Person' }],
    update: payload => f.links.update(payload),
  });
  const main = { kind: 'bot', id: 'chief' }, group = { kind: 'room', id: 'team' };
  assert.deepEqual((await settings.view(group)).chats.map(row => row.chatId), ['team@chatroom']);
  const privateView = await settings.view(main);
  assert.equal(privateView.connections.find(row => row.provider === 'weixin').policy, 'open', 'iLink does not inherit Pad DM policy');
  assert.equal(JSON.stringify(privateView).includes(config.token), false);
  assert.deepEqual(privateView.chats.map(row => row.chatId), ['opaque-user', 'person']);
  await settings.update(main, { provider: 'weixin', chatId: 'opaque-user', revision: 0 });
  await settings.update(group, { provider: 'pad', chatId: 'team@chatroom', revision: 1 });
  await assert.rejects(settings.update(main, { provider: 'pad', chatId: 'team@chatroom', revision: 2 }), /微信群只能/);
  await assert.rejects(settings.update(main, { provider: 'weixin', chatId: 'team@chatroom', revision: 2 }), /不支持/);
  await assert.rejects(settings.view({ kind: 'bot', id: 'worker' }), /eligible/);
  f.targets.push({ kind: 'bot', id: 'other-main', name: 'Other' });
  await assert.rejects(settings.update({ kind: 'bot', id: 'other-main' }, { provider: 'weixin', chatId: 'opaque-user', revision: 2 }), /其他目标/);
  connected = false;
  assert.equal((await settings.view(group)).connections[0].state, 'error');
  assert.equal((await settings.view(group)).links.length, 1);
  await assert.rejects(settings.update(group, { provider: 'pad', chatId: 'new@chatroom', revision: 2 }), /尚未就绪/);
  await settings.update(group, { provider: 'pad', chatId: 'team@chatroom', remove: true, revision: 2 });
  assert.equal((await settings.view(group)).links.length, 0, 'offline unlink remains available');
  await assert.rejects(settings.update(main, { provider: 'weixin', chatId: 'new-user', revision: 0 }), /其他窗口/);
});

test('availability distinguishes disabled, incomplete, signed-out, connecting, disconnected and failed connections', () => {
  const cfg = { enabled: true, enabledProviders: ['pad', 'weixin'], baseUrl: 'fixture', token: 'test', wxid: 'test' };
  assert.equal(linkConnectionState({ ...cfg, enabled: false }, {}, 'pad'), 'disabled');
  assert.equal(linkConnectionState({ ...cfg, token: '' }, {}, 'pad'), 'unconfigured');
  assert.equal(linkConnectionState(cfg, { phase: 'unconfigured' }, 'weixin'), 'login-required');
  assert.equal(linkConnectionState(cfg, { phase: 'starting' }, 'weixin'), 'connecting');
  assert.equal(linkConnectionState(cfg, { phase: 'stopped' }, 'pad'), 'disconnected');
  assert.equal(linkConnectionState(cfg, { phase: 'error', connected: true }, 'pad'), 'error');
  assert.equal(linkConnectionState(cfg, { phase: 'connected', connected: true }, 'weixin'), 'ready');
});

test('discovered robot users persist without message bodies or protocol context credentials', async t => {
  const f = await fixture(t), directory = new ChatDirectory(f.directory);
  await directory.note('weixin', { chatId: 'opaque-open-id', senderName: 'Fixture user', text: 'private body', contextToken: 'private-context-token' });
  await directory.note('pad', { chatId: 'team@chatroom', isGroup: true, senderName: 'Member name' });
  const disk = await readFile(join(f.directory, 'known-chats.json'), 'utf8');
  assert.equal(disk.includes('private'), false);
  const restored = new ChatDirectory(f.directory);
  assert.deepEqual(await restored.list(), [{ provider: 'weixin', chatId: 'opaque-open-id', label: 'Fixture user' }, { provider: 'pad', chatId: 'team@chatroom', label: 'team@chatroom' }]);
});

test('linked private messages forward interrupt preferences and activity tracking, while groups remain queued', async t => {
  const f = await fixture(t), calls = [];
  f.bridge.activity = async () => ({ busy: true });
  const typing = { acquire: (...args) => calls.push(args), releasePrefix: () => {} };
  const links = new BotLinks({ ...f.options, typing });
  t.after(() => links.dispose());
  await links.update({ provider: 'weixin', chatId: 'robot-user', target: { kind: 'bot', id: 'chief' }, revision: 0 });
  await links.receive(await links.binding('weixin', 'robot-user'), { messageId: '1' }, { text: 'Stop', mode: 'interrupt' });
  assert.equal(f.prompts[0].content.mode, 'interrupt');
  assert.equal(calls[0][0], 'weixin'); assert.equal(await calls[0][3](), true);
  await links.update({ provider: 'pad', chatId: 'team@chatroom', isGroup: true, target: { kind: 'room', id: 'team' }, revision: 1 });
  await links.receive(await links.binding('pad', 'team@chatroom'), { messageId: '2' }, { text: 'Group', mode: 'interrupt' });
  assert.equal(f.prompts[1].content.mode, 'queue');
  f.bridge.supportsInterrupt = false;
  await assert.rejects(links.receive(await links.binding('weixin', 'robot-user'), { messageId: '3' }, { text: 'Do not silently queue', mode: 'interrupt' }), /请更新/);
  assert.equal(f.prompts.length, 2);
});
