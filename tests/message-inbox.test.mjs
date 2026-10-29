import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageInbox } from '../host/message-inbox.js';

const message = (text, chatId = 'chat', senderId = 'alice') => ({ text, chatId, senderId });
const drain = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('inbox: trailing delay merges rapid messages once in their original order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const inbox = new MessageInbox({ dispatch: async (m) => sent.push(m), onError: assert.fail });
  t.after(() => inbox.dispose());
  inbox.add(message('1'), 2000);
  t.mock.timers.tick(1500);
  inbox.add(message('2'), 2000);
  t.mock.timers.tick(1500);
  inbox.add(message('3'), 2000);
  t.mock.timers.tick(1999);
  await drain();
  assert.deepEqual(sent, []);
  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(sent.map((m) => m.text), ['1\n2\n3']);
});

test('inbox: chats and group senders stay separate, and admissions serialize per chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  const inbox = new MessageInbox({ dispatch: async (m) => seen.push(m), onError: assert.fail });
  t.after(() => inbox.dispose());
  inbox.add(message('alice'), 1000);
  inbox.add(message('bob', 'chat', 'bob'), 1000);
  inbox.add(message('other chat', 'other'), 1000);
  t.mock.timers.tick(1000);
  await drain();
  assert.deepEqual(seen.filter((m) => m.chatId === 'chat').map((m) => [m.senderId, m.text]), [['alice', 'alice'], ['bob', 'bob']]);
  assert.equal(seen.find((m) => m.chatId === 'other').text, 'other chat');

  let release;
  const order = [];
  const serial = new MessageInbox({ dispatch: async (m) => {
    order.push(m.text);
    if (m.text === 'first') await new Promise((resolve) => { release = resolve; });
  }, onError: assert.fail });
  t.after(() => serial.dispose());
  serial.add(message('first'), 0);
  const second = serial.add(message('second'), 0);
  await drain();
  assert.deepEqual(order, ['first']);
  release();
  await second;
  assert.deepEqual(order, ['first', 'second']);
});

test('inbox: stop/reset cancels buffered and waiting admissions, errors do not block later messages', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  const errors = [];
  const inbox = new MessageInbox({ dispatch: async (m) => {
    if (m.text === 'bad') throw new Error('failed');
    seen.push(m.text);
  }, onError: async (m, e) => errors.push([m.text, e.message]) });
  t.after(() => inbox.dispose());
  inbox.add(message('buffered'), 2000);
  inbox.add(message('not admitted yet'), 0);
  inbox.cancelChat('chat');
  t.mock.timers.tick(2000);
  await drain();
  assert.deepEqual(seen, []);
  inbox.add(message('bad'), 0);
  await inbox.add(message('good'), 0);
  assert.deepEqual(seen, ['good']);
  assert.deepEqual(errors, [['bad', 'failed']]);
});

test('inbox: disabling delay flushes the existing batch and teardown drops pending timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  const inbox = new MessageInbox({ dispatch: async (m) => seen.push(m.text), onError: assert.fail });
  inbox.add(message('a'), 2000);
  await inbox.add(message('b'), 0);
  assert.deepEqual(seen, ['a\nb']);
  inbox.add(message('pending'), 2000);
  inbox.dispose();
  t.mock.timers.tick(2000);
  await drain();
  assert.deepEqual(seen, ['a\nb']);
});
