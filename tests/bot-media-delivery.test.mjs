import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { BotLinks } from '../host/bot-links.js';
import { installOutboundArtifactTool, outboundArtifactRegistry } from '../host/vendor/artifact.js';

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('media delivery did not settle'); await new Promise(setImmediate); }
}
async function fixture(t) {
  const directory = await mkdtemp('/tmp/wechat-linked-media-'), events = new Context();
  const files = [], texts = [], prompts = [], sessions = new Map(), listeners = new Set(), settings = { fail: false };
  let definition, guidance;
  const session = id => { if (!sessions.has(id)) sessions.set(id, { id, header: { id, cwd: directory }, events: [] }); return sessions.get(id); };
  const bridge = { version: 1, supportsMedia: true, supportsInterrupt: true,
    resolve: async target => { if (settings.deleted) throw new Error('target removed'); return { ...target, sessionId: target.kind === 'room' ? 'room-session' : 'chief-session' }; },
    targets: async () => [], stop: async () => true,
    send: async (target, request) => { const resolved = await bridge.resolve(target); const cancel = request.beforePrompt?.(resolved.sessionId, request.requestId); if (settings.admissionFailed) { cancel?.(); throw new Error('admission failed'); } prompts.push({ ...request, sessionId: resolved.sessionId }); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const ctx = { on: events.on.bind(events), get: name => name === 'mekBotBridge' ? bridge : name === 'sessions' ? { get: session } : undefined,
    tools: { register: tool => { definition = tool; } }, systemPrompt: { context: source => { guidance = source; } }, logger: { warn() {} } };
  installOutboundArtifactTool(ctx);
  const links = new BotLinks({ ctx, directory, send: async (provider, chatId, text) => { texts.push({ provider, chatId, text }); return { ok: true }; },
    sendFile: async (provider, chatId, file) => { if (settings.fail) return { ok: false, error: 'provider refused' }; files.push({ provider, chatId, name: file.fileName, bytes: Buffer.from(file.bytes), mediaType: file.mediaType }); return { ok: true }; } });
  links.start();
  t.after(async () => { await links.dispose(); for (const s of sessions.values()) outboundArtifactRegistry.disposeSession(s); await rm(directory, { recursive: true, force: true }); });
  const emit = async (id, type, data = {}) => { const s = session(id), event = { seq: s.events.length, type, data }; s.events.push(event); await events.emit('session/event', s, event); };
  const link = async (provider = 'weixin', chatId = 'peer', target = { kind: 'bot', id: 'chief' }) => { await links.update({ provider, chatId, target, isGroup: target.kind === 'room', revision: (await links.view()).revision }); return links.binding(provider, chatId); };
  const receive = async binding => { await links.receive(binding, { messageId: crypto.randomUUID() }, { text: 'Send an attachment' }); return prompts.at(-1); };
  const claim = async (request, turn, source = { kind: 'user', rpcId: request.requestId }) => {
    await emit(request.sessionId, 'turn/start', { turn });
    const message = { source, content: [{ type: 'text', text: 'Send it' }] };
    await events.emit('agent/inbox/claimed', { agent: { session: session(request.sessionId) }, message, turn });
    await emit(request.sessionId, 'user/message', message);
  };
  const present = async (request, name, fail = false) => {
    const path = join(directory, name); await writeFile(path, `original ${name}`);
    const exec = { name: 'present', callId: `present-${name}`, arguments: { files: [{ path }] }, agent: { session: session(request.sessionId) } };
    const result = await events.waterfall('tools/execute', exec, async () => ({ isError: fail }));
    await events.emit('tools/result', exec, result);
    await writeFile(path, 'changed after present');
  };
  return { directory, links, bridge, files, texts, prompts, settings, session, emit, link, receive, claim, present,
    guidance: request => guidance.text({ agent: { session: session(request.sessionId) } }),
    register: async (request, name) => { const path = join(directory, name); await writeFile(path, `original ${name}`); const exec = { name: definition.name, callId: name, agent: { session: session(request.sessionId) } }; await definition.execute({ path }, exec); await events.emit('tools/result', exec, { isError: false }); },
    visible: event => { for (const listener of listeners) listener(event); },
  };
}

test('linked Main Bot returns voice, images and files to the originating connection from immutable snapshots', async t => {
  const f = await fixture(t), qr = await f.link(), pad = await f.link('pad', 'pad-peer');
  const first = await f.receive(qr), second = await f.receive(pad);
  await f.claim(first, 1);
  for (const kind of ['runtime-context', 'skill-catalog', 'time-context']) await f.emit(first.sessionId, 'user/message', { source: { kind, form: 'snapshot' }, content: [{ type: 'text', text: 'host context' }] });
  assert.match(f.guidance(first), /audio as a file/);
  await f.present(first, 'voice.wav'); await f.present(first, 'picture.png'); await f.register(first, 'report.pdf');
  assert.equal(f.files.length, 0);
  await f.emit(first.sessionId, 'turn/end', { turn: 1 });
  await until(() => f.files.length === 3);
  assert.deepEqual(f.files.map(file => [file.provider, file.chatId, file.name]), [['weixin', 'peer', 'voice.wav'], ['weixin', 'peer', 'picture.png'], ['weixin', 'peer', 'report.pdf']]);
  assert.equal(f.files[0].bytes.toString(), 'original voice.wav');
  await f.claim(second, 2);
  assert.match(f.guidance(second), /60 seconds/);
  await f.present(second, 'native.wav'); await f.emit(second.sessionId, 'turn/end', { turn: 2 });
  await until(() => f.files.length === 4);
  assert.equal(f.files[3].provider, 'pad'); assert.equal(f.files[3].chatId, 'pad-peer');
});

test('linked file delivery rejects web turns, failed tools, cancellation and unlinked targets', async t => {
  const f = await fixture(t), binding = await f.link();
  const request = await f.receive(binding);
  await f.claim(request, 1, { kind: 'user', rpcId: 'web-request' });
  await f.present(request, 'web.png'); await f.emit(request.sessionId, 'turn/end', { turn: 1 });
  await f.claim(await f.receive(binding), 2); await f.present(request, 'failed.png', true); await f.emit(request.sessionId, 'turn/end', { turn: 2 });
  await f.claim(await f.receive(binding), 3); await f.present(request, 'aborted.wav'); await f.emit(request.sessionId, 'turn/end', { turn: 3, reason: { kind: 'aborted' } });
  await f.claim(await f.receive(binding), 4); await f.present(request, 'unlinked.pdf');
  await f.links.update({ ...binding, target: null, revision: (await f.links.view()).revision });
  await f.emit(request.sessionId, 'turn/end', { turn: 4 });
  assert.equal(f.files.length, 0);
  assert.equal(outboundArtifactRegistry.hasActiveConsumer(f.session(request.sessionId)), false);
});

test('linked markup snapshots dedupe present files and failures are reported in the original chat', async t => {
  const f = await fixture(t), binding = await f.link(), request = await f.receive(binding);
  await f.claim(request, 1); await f.present(request, 'duplicate.png');
  await writeFile(join(f.directory, 'duplicate.png'), 'original duplicate.png');
  await f.emit(request.sessionId, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '![picture](duplicate.png)' }] } });
  await f.emit(request.sessionId, 'turn/end', { turn: 1 }); await until(() => f.files.length === 1);
  await f.claim(await f.receive(binding), 2); await f.present(request, 'refused.pdf'); f.settings.fail = true;
  await f.emit(request.sessionId, 'turn/end', { turn: 2 }); await until(() => f.texts.some(row => /provider refused/.test(row.text)));
  assert.match((await f.links.view()).lastError, /provider refused/);
  assert.equal(f.texts.at(-1).chatId, 'peer');
});

test('mixed origins in one turn and failed admission cannot borrow linked attachment permission', async t => {
  const f = await fixture(t), a = await f.link(), b = await f.link('pad', 'another');
  const first = await f.receive(a), second = await f.receive(b); await f.claim(first, 1);
  await f.present(first, 'before-mix.png');
  const message = { source: { kind: 'user', rpcId: second.requestId } };
  // The second connection is claimed into the same active turn.
  await f.emit(first.sessionId, 'user/message', message);
  await f.emit(first.sessionId, 'turn/end', { turn: 1 });
  assert.equal(f.files.length, 0);
  f.settings.admissionFailed = true;
  await assert.rejects(f.receive(a), /admission failed/);
});

test('visible Bot group attachment markup sends real files and strips local paths from copied text', async t => {
  const f = await fixture(t), target = { kind: 'room', id: 'team' }; await f.link('pad', 'group@chatroom', target);
  await writeFile(join(f.directory, 'group.png'), 'group image');
  f.visible({ id: 'group:1', target, text: 'Writer: Ready ![image](group.png)' });
  await until(() => f.files.length === 1);
  assert.equal(f.texts[0].text, 'Writer: Ready'); assert.equal(f.files[0].chatId, 'group@chatroom');
});
