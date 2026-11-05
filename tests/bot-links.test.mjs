import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BotLinks } from '../host/bot-links.js';

async function fixture(t) {
  const directory = await mkdtemp('/tmp/wechat-bot-links-');
  const listeners = new Set(), sends = [], prompts = [], targets = [
    { kind: 'bot', id: 'chief', name: 'Chief', sessionId: 'chief-part-2' },
    { kind: 'room', id: 'team', name: 'Team', sessionId: 'team-part-3' },
  ];
  const bridge = {
    version: 1, targets: async () => targets,
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
