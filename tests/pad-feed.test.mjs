import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPadWsUrl, unwrapPadFrame } from '../host/pad-feed.js';
import { decodeOneBot } from '../host/onebot-message.js';

test('OneBot subscription uses the standard root without leaking query credentials', () => {
  const url = new URL(buildPadWsUrl({ baseUrl: 'http://wechat-bot:8062', token: 'secret', wxid: 'bot' }));
  assert.equal(url.pathname, '/'); assert.equal(url.search, ''); assert.equal(url.protocol, 'ws:');
  assert.equal(unwrapPadFrame({ type: 'meta', detail_type: 'heartbeat' }).control, 'heartbeat');
});
test('OneBot group mentions and 64-bit IDs decode without native source', () => {
  const event = { type: 'message', detail_type: 'group', self: { platform: 'wechat', user_id: 'bot' }, message_id: '9007199254740993', time: 1,
    user_id: 'peer', group_id: 'room@chatroom', message: [{ type: 'mention', data: { user_id: 'bot' } }, { type: 'text', data: { text: 'hello' } }] };
  const frame = unwrapPadFrame(event); const message = decodeOneBot(frame.message, null);
  assert.equal(message.messageId, '9007199254740993'); assert.equal(message.mentioned, true); assert.equal(message.chatId, 'room@chatroom');
});
