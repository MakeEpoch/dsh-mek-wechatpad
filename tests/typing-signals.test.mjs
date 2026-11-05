import test from 'node:test';
import assert from 'node:assert/strict';
import { TypingSignals } from '../host/typing-signals.js';
const settle = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };

test('typing leases start, refresh and stop only after the last ordinary/linked owner releases', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const sent = [], signals = new TypingSignals({ send: async (...args) => { sent.push(args); return true; } });
  t.after(() => signals.dispose());
  const first = signals.acquire('weixin', 'user', 'ordinary:1'), second = signals.acquire('weixin', 'user', 'linked:2');
  signals.acquire('pad', 'ignored', 'pad:1'); await settle();
  assert.deepEqual(sent, [['weixin', 'user', true]]);
  t.mock.timers.tick(8001); await settle();
  assert.deepEqual(sent.at(-1), ['weixin', 'user', true]); assert.equal(sent.length, 2);
  first(); await settle(); assert.equal(sent.length, 2);
  second(); await settle(); assert.deepEqual(sent.at(-1), ['weixin', 'user', false]);
  t.mock.timers.tick(16000); await settle(); assert.equal(sent.length, 3);
});

test('linked activity ends when idle or invalid, and stale async checks cannot release a new owner', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const sent = [], signals = new TypingSignals({ send: async (_p, _c, on) => { sent.push(on); return true; } });
  t.after(() => signals.dispose());
  let finish;
  const oldRelease = signals.acquire('weixin', 'user', 'linked:a', () => new Promise(resolve => { finish = resolve; }));
  await signals.tick(); await settle();
  const newRelease = signals.acquire('weixin', 'user', 'linked:a', async () => true);
  oldRelease(); finish(false); t.mock.timers.tick(5000); await settle();
  assert.equal(sent.includes(false), false);
  newRelease(); await settle(); assert.equal(sent.at(-1), false);
  signals.acquire('weixin', 'other', 'linked:b', async () => { throw Error('target deleted'); });
  await signals.tick(); await settle(); assert.equal(sent.at(-1), false);
});

test('disabled typing and delivery errors never fail a prompt; shutdown serializes the final stop', async t => {
  const sent = [], warnings = [];
  let enabled = false;
  const signals = new TypingSignals({ enabled: () => enabled, send: async (_p, _c, on) => { sent.push(on); throw Error('fixture'); }, logger: (...args) => warnings.push(args) });
  signals.acquire('weixin', 'user', 'linked:a'); await settle(); assert.equal(sent.length, 0);
  enabled = true; signals.acquire('weixin', 'user', 'linked:a'); await settle();
  await signals.dispose(); assert.deepEqual(sent, [true, false]); assert.ok(warnings.length > 0);
});
