import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { extractReplyMedia } from '../host/reply-media.js';
import { installOutboundArtifactTool, OutboundArtifactRegistry } from '../host/vendor/artifact.js';

test('explicit attachment syntax handles relative/absolute image and document paths and Hermes markers', () => {
  const result = extractReplyMedia('说明\n![日落湖景](sunset.png)\n[报告](<report v2.pdf>)\n<wximg>/tmp/a.png</wximg>\nMEDIA: /tmp/a.png\n结束', '/work');
  assert.deepEqual(result.paths, ['/work/sunset.png', '/work/report v2.pdf', '/tmp/a.png']);
  assert.equal(result.text, '说明\n\n结束');
});
test('prose paths, remote URLs and code examples are not attachment commands', () => {
  const text = '/etc/passwd\n`![x](private.png)`\n```\nMEDIA: /private\n```\n![web](https://example.com/a.png)\n[站点](https://example.com)';
  assert.deepEqual(extractReplyMedia(text, '/work'), { text, paths: [] });
});
test('host without tools installs into each actual Agent scope before prompt assembly', async () => {
  const events = new Context();
  const registry = new OutboundArtifactRegistry();
  const guard = target => new Proxy(target, { get(object, key) {
    if (key === 'tools' || key === 'systemPrompt') throw new Error(`cannot get property "${key}" without inject`);
    return Reflect.get(object, key);
  } });
  const root = guard({ on: events.on.bind(events), get: () => undefined });
  assert.equal(installOutboundArtifactTool(root, { registry }), true);
  const tools = [], contexts = [];
  const session = { id: 'scoped-agent', header: { id: 'scoped-agent', cwd: '/work' }, events: [{ type: 'turn/start', data: { turn: 1 } }] };
  const services = { tools: { register: x => { tools.push(x); } }, systemPrompt: { context: x => { contexts.push(x); } } };
  const ctx = guard({ get: name => services[name] });
  const agent = { ctx, session };
  await events.emit('agent/created', { agent });
  assert.deepEqual(tools.map(x => x.name), ['wechatpad_return_file']);
  assert.equal(contexts[0].text({ agent }), '');
  const close = registry.openTurnConsumer(session.id, 1);
  await events.emit('agent/inbox/claimed', { agent, message: {}, turn: 1 });
  assert.equal(tools.length, 1, 'claim does not duplicate registration');
  assert.match(contexts[0].text({ agent }), /This turn replies to a WeChat conversation/);
  assert.equal(contexts[0].required, true);
  close();
});
