import test from 'node:test';
import assert from 'node:assert/strict';
import { WechatPadClient } from '../host/pad-api.js';
import { outboundTarget, resolveConfig } from '../host/config.js';
import { buildBridgeWsUrl, unwrapBridgeFrame } from '../host/bridge.js';
import { decodeMessage } from '../host/inbound.js';

test('wechatReal08: subscription and sends share the configured token without leaking it into API URLs', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return Response.json({ Code: 200, Success: true, Data: { NewMsgId: '9007199254740993' } });
  });
  const config = resolveConfig({ receiveMode: 'bridge', bridgeBaseUrl: 'http://wechat-bot:8062', bridgeToken: 'test-secret', bridgeAccounts: 'wxid_bot' });
  const target = outboundTarget(config);
  const result = await new WechatPadClient(target).sendText('wxid_friend', 'hello');
  assert.equal(result.ok, true);
  assert.equal(result.messageId, '9007199254740993');
  assert.equal(calls[0].url.pathname, '/proxy/wxid_bot/message/SendTextMessage');
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].options.headers['X-Bridge-Token'], 'test-secret');
  const ws = new URL(buildBridgeWsUrl({ baseUrl: target.baseUrl, token: config.bridgeToken, accounts: ['wxid_bot'] }));
  assert.equal(ws.port, '8062');
  assert.equal(ws.searchParams.get('token'), 'test-secret');
});

test('wechatReal08: normalized native group message preserves exact IDs and mention routing', () => {
  const frame = unwrapBridgeFrame({ type: 'message', wxid: 'wxid_bot', message: {
    msg_id: 123, new_msg_id: '9007199254740993', msg_type: 1,
    from_user_name: { str: 'room@chatroom' }, to_user_name: { str: 'wxid_bot' },
    content: { str: 'wxid_friend:\n@Bot\u2005 hello' },
    msg_source: '<msgsource><atuserlist>wxid_bot</atuserlist></msgsource>', create_time: 1700000000,
  } });
  const message = decodeMessage(frame.message, { selfWxid: frame.wxid });
  assert.equal(message.messageId, '9007199254740993');
  assert.equal(message.chatId, 'room@chatroom');
  assert.equal(message.senderId, 'wxid_friend');
  assert.equal(message.mentioned, true);
});
