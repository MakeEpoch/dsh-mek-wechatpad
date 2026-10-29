import test from 'node:test';
import assert from 'node:assert/strict';

import { Config, outboundTarget, resolveConfig, resolveDefaults, splitList, chatSettingsFor } from '../host/config.js';
import { workspaceForChat } from '../host/wechatpad-service.js';
import {
  applyPolicy, cleanupText, chunkText, decodeMessage, looksLikeMentionPush, parseAtUserList, stripReasoning,
} from '../host/inbound.js';
import { chalk } from '../host/outbound.js';
import { DedupeWindow, parseFrame, reconnectDelay } from '../host/transport.js';
import { extractAssistantText } from '../host/harness.js';
import { WechatPadClient, extractMessageId, isRetryable, normalizeEnvelope } from '../host/pad-api.js';
import {
  isEditableField, panelDefaults, panelReadModel, resolveSettingsEntry, savePanelSettings,
} from '../host/settings-bridge.js';

/** Build a raw WechatPad payload the way the Pad actually pushes one. */
function padMessage({ fromUser, toUser, content, msgType = 1, id = 'm1', atUsers }) {
  return {
    from_user_name: { str: fromUser },
    to_user_name: { str: toUser },
    content: { str: content },
    msg_type: msgType,
    new_msg_id: id,
    create_time: 1_700_000_000,
    AtWxIDList: atUsers,
  };
}

test('config: defaults fill every field and lists accept comma or full-width separators', () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:8059');
  assert.equal(resolved.receiveMode, 'websocket');
  assert.equal(resolved.dmPolicy, 'allowlist');
  assert.equal(resolved.groupPolicy, 'disabled');
  assert.deepEqual(resolved.allowedUsers, []);
  assert.equal(resolved.key, '');
  assert.deepEqual(splitList('a, b，c\nd'), ['a', 'b', 'c', 'd']);
});

test('chat settings override only selected fields and inherit updated general values', () => {
  const config = resolveConfig({
    mergeReplies: true, showProgress: true, messageMergeDelaySeconds: 2,
    chatOverrides: [{ provider: 'pad', chatId: 'user_example', mergeReplies: false, showProgress: 'inherit', messageMergeDelaySeconds: 0 }],
  });
  const specific = chatSettingsFor(config, 'pad', 'user_example');
  assert.equal(specific.mergeReplies, false);
  assert.equal(specific.showProgress, true);
  assert.equal(specific.messageMergeDelaySeconds, 0);
  assert.equal(chatSettingsFor(config, 'weixin', 'user_example').mergeReplies, true);
  assert.equal(workspaceForChat('pad', 'user_example').endsWith('/wechat/user_example'), true);
  assert.equal(workspaceForChat('pad', '../escape').includes('..'), false);
});

test('config: baseUrl is trimmed, prefixes normalized, numbers clamped', () => {
  const resolved = resolveConfig({
    baseUrl: 'http://127.0.0.1:8059///',
    apiPrefix: 'proxy/',
    webhookPath: 'hook',
    requestTimeoutSeconds: 999,
    maxReplyChunkLength: 1,
  });
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:8059');
  assert.equal(resolved.apiPrefix, '/proxy');
  assert.equal(resolved.webhookPath, '/hook');
  assert.equal(resolved.requestTimeoutSeconds, 120);
  assert.equal(resolved.maxReplyChunkLength, 100);
});

test('config: removed persistence setting is ignored in legacy profiles and panel reads', () => {
  assert.equal(resolveConfig(Config({ persistBinding: true })).persistBinding, undefined);
  assert.equal(resolveConfig({ persistBinding: true }).persistBinding, undefined);
  assert.equal(panelReadModel({ persistBinding: true }).persistBinding, undefined);
});

test('inbound: direct message decodes to its sender and text', () => {
  const message = decodeMessage(padMessage({ fromUser: 'wxid_a', toUser: 'wxid_bot', content: '你好' }));
  assert.equal(message.chatId, 'wxid_a');
  assert.equal(message.senderId, 'wxid_a');
  assert.equal(message.isGroup, false);
  assert.equal(message.text, '你好');
  assert.equal(message.messageId, 'm1');
});

test('inbound: group message carries the real speaker and mention state', () => {
  const message = decodeMessage(padMessage({
    fromUser: '123@chatroom',
    toUser: 'wxid_bot',
    content: 'wxid_alice:\n@bot\u2005帮我看下代码',
    atUsers: ['wxid_bot'],
  }), { selfWxid: 'wxid_bot' });
  assert.equal(message.isGroup, true);
  assert.equal(message.chatId, '123@chatroom');
  assert.equal(message.senderId, 'wxid_alice');
  assert.equal(message.mentioned, true);
  assert.equal(message.text, '帮我看下代码');
});

test('inbound: bot-authored group messages have no speaker and cannot wake the bot', () => {
  const message = decodeMessage(padMessage({ fromUser: '123@chatroom', toUser: 'wxid_bot', content: '普通文字' }));
  assert.equal(message.senderId, '123@chatroom');
});

test('inbound: media messages become readable placeholders, never control XML', () => {
  const image = decodeMessage(padMessage({ fromUser: 'wxid_a', toUser: 'wxid_bot', content: '<msg><img/></msg>', msgType: 3 }));
  assert.equal(image.text, '[图片]');
  const voice = decodeMessage(padMessage({ fromUser: 'wxid_a', toUser: 'wxid_bot', content: '', msgType: 34 }));
  assert.equal(voice.text, '[语音消息]');
});

test('inbound: cleanupText removes mention markup and collapses spaces', () => {
  assert.equal(cleanupText('@someone\u2005  你好  世界'), '你好 世界');
  assert.equal(cleanupText('普通 文本'), '普通 文本');
});

test('policy: dm allowlist, disabled, and group mention rules', () => {
  const config = resolveConfig({ dmPolicy: 'allowlist', allowedUsers: ['wxid_a'], groupPolicy: 'allowlist', allowedGroups: ['1@chatroom'], groupRequireMention: true });
  const direct = decodeMessage(padMessage({ fromUser: 'wxid_a', toUser: 'wxid_bot', content: 'hi' }));
  const stranger = decodeMessage(padMessage({ fromUser: 'wxid_c', toUser: 'wxid_bot', content: 'hi', id: 'm2' }));
  assert.equal(applyPolicy(direct, config, 'wxid_bot').allowed, true);
  assert.equal(applyPolicy(stranger, config, 'wxid_bot').reason, 'dm-not-allowed');

  const group = decodeMessage(padMessage({ fromUser: '1@chatroom', toUser: 'wxid_bot', content: 'wxid_a:\n@bot\u2005问题', id: 'm3', atUsers: ['wxid_bot'] }), { selfWxid: 'wxid_bot' });
  assert.equal(applyPolicy(group, config, 'wxid_bot').allowed, true);
  const unmentioned = decodeMessage(padMessage({ fromUser: '1@chatroom', toUser: 'wxid_bot', content: 'wxid_a:\n随便聊天', id: 'm4' }));
  assert.equal(applyPolicy(unmentioned, config, 'wxid_bot').reason, 'group-not-mentioned');

  const selfEcho = decodeMessage(padMessage({ fromUser: 'wxid_bot', toUser: 'wxid_a', content: '我的回复', id: 'm5' }));
  assert.equal(applyPolicy(selfEcho, config, 'wxid_bot').reason, 'self-echo');

  const disabled = resolveConfig({ dmPolicy: 'disabled', groupPolicy: 'disabled' });
  assert.equal(applyPolicy(direct, disabled, 'wxid_bot').reason, 'dm-disabled');
});

test('group messages @mentioning others do not wake the bot, even with open mention policy', () => {
  const raw = (atUsers, content = 'alice:\n@别人\u2005看看') => padMessage({
    fromUser: '1@chatroom', toUser: 'wxid_bot', content, atUsers,
  });
  const onlyOther = decodeMessage(raw(['wxid_other']), { selfWxid: 'wxid_bot', selfNickname: 'Bot' });
  assert.equal(onlyOther.mentioned, false);
  assert.equal(onlyOther.otherMentionOnly, true);
  assert.equal(onlyOther.contextText, '@别人\u2005看看');
  for (const groupRequireMention of [true, false]) {
    const config = resolveConfig({ groupPolicy: 'open', groupRequireMention });
    assert.equal(applyPolicy(onlyOther, config, 'wxid_bot').reason, 'group-other-mentioned');
    assert.equal(applyPolicy({ ...onlyOther, mentioned: true }, config, 'wxid_bot').reason, 'group-other-mentioned');
  }
  const both = decodeMessage(raw(['wxid_other', 'wxid_bot']), { selfWxid: 'wxid_bot' });
  assert.equal(both.mentioned, true);
  assert.equal(both.otherMentionOnly, false);
  const unknownSelf = decodeMessage(raw(['wxid_other']));
  assert.equal(unknownSelf.mentioned, false);
  assert.equal(unknownSelf.otherMentionOnly, true);
  const visibleOnly = decodeMessage(raw([], 'alice:\n@别人\u2005看看'), { selfWxid: 'wxid_bot' });
  assert.equal(visibleOnly.otherMentionOnly, true);
});

test('reply shaping: chunks respect the limit and strip markdown and reasoning', () => {
  const text = `${'第一段。'.repeat(30)}\n\n${'第二段。'.repeat(30)}`;
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 100, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));

  assert.equal(chalk('**粗体** 和 `代码`\n# 标题'), '粗体 和 代码\n标题');
  assert.equal(stripReasoning('正常回答'), '正常回答');
  assert.equal(stripReasoning('正常回答'), '正常回答');
});

test('transport: dedupe window stops replays but not distinct ids', () => {
  const window = new DedupeWindow({ limit: 3, ttlMs: 1000 });
  assert.equal(window.duplicate('a'), false);
  assert.equal(window.duplicate('a'), true);
  assert.equal(window.duplicate('b'), false);
});

test('transport: push frames split into message, batch, and status kinds', () => {
  const raw = JSON.stringify(padMessage({ fromUser: 'wxid_a', toUser: 'wxid_bot', content: 'hi' }));
  assert.equal(parseFrame(raw).kind, 'message');
  assert.equal(parseFrame(JSON.stringify([JSON.parse(raw), JSON.parse(raw)])).kind, 'batch');
  assert.equal(parseFrame(JSON.stringify({ Code: -2, Success: false, Text: 'bad key' })).kind, 'status');
  assert.equal(parseFrame('not json').kind, 'invalid');
  assert.ok(reconnectDelay(0) >= 2000);
  assert.ok(reconnectDelay(20) <= 60_000);
});

test('pad api: envelopes from Pad and Bridge normalize to ok/error', () => {
  assert.deepEqual(normalizeEnvelope({ Success: true, Code: 200, Data: { v: 1 } }), { ok: true, data: { v: 1 } });
  assert.equal(normalizeEnvelope({ Success: false, Code: -2, Text: 'bad key' }).ok, false);
  // A healthy account probe answers Code 200 with Success false; Code is the
  // transport verdict, so this must read as success.
  assert.deepEqual(normalizeEnvelope({ Code: 200, Success: false, Data: { loginState: 1 } }), { ok: true, data: { loginState: 1 } });
  assert.equal(normalizeEnvelope({ ok: false, error: 'bridge down' }).error, 'bridge down');
  assert.deepEqual(normalizeEnvelope({ ok: true, accounts: [] }), { ok: true, data: { accounts: [] } });
  assert.equal(isRetryable('connection refused'), true);
  assert.equal(isRetryable('unauthorized'), false);
  assert.equal(extractMessageId({ chat_send_ret_list: [{ newMsgId: 42 }] }), '42');
});

test('pad api: bridge proxy needs a wxid but delegates the account key', () => {
  const direct = new WechatPadClient({ baseUrl: 'http://127.0.0.1:8059', key: 'k' });
  assert.equal(direct.url('/message/SendTextMessage'), 'http://127.0.0.1:8059/message/SendTextMessage');
  assert.equal(direct.configured, true);

  const bridged = new WechatPadClient({ baseUrl: 'http://127.0.0.1:8002', key: 'auth', apiPrefix: '/proxy', wxid: 'wxid_bot' });
  assert.equal(bridged.url('/message/SendTextMessage'), 'http://127.0.0.1:8002/proxy/wxid_bot/message/SendTextMessage');
  assert.equal(bridged.configured, true);

  const incomplete = new WechatPadClient({ baseUrl: 'http://127.0.0.1:8002', key: 'auth', apiPrefix: '/proxy' });
  assert.equal(incomplete.configured, false);
});

test('pad api: actual requests omit Bridge keys and retain direct Pad authentication', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: new URL(url), options });
    return Response.json({ Code: 200, Success: false, Data: { isSendSuccess: true, chat_send_ret_list: [{ newMsgId: '123' }] } });
  });
  const target = outboundTarget(resolveConfig({
    receiveMode: 'bridge', bridgeBaseUrl: 'http://bridge.test', bridgeAccounts: 'wxid_bot',
  }));
  const bridge = new WechatPadClient(target);
  assert.equal(bridge.configured, true, 'no Pad key is needed in Bridge mode');
  const receipt = await bridge.sendText('1@chatroom', '群回复');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.messageId, '123');
  assert.equal(requests[0].url.pathname, '/proxy/wxid_bot/message/SendTextMessage');
  assert.equal(requests[0].url.searchParams.has('key'), false);
  assert.equal(JSON.parse(requests[0].options.body).MsgItem[0].ToUserName, '1@chatroom');

  const staleKey = new WechatPadClient({ ...target, key: 'bridge' });
  await staleKey.sendText('wxid_peer', '私聊回复');
  assert.equal(requests[1].url.searchParams.has('key'), false, 'even a stale placeholder must not override Bridge authentication');
  assert.equal(JSON.parse(requests[1].options.body).MsgItem[0].ToUserName, 'wxid_peer');

  const direct = new WechatPadClient({ baseUrl: 'http://pad.test', key: 'pad-secret' });
  await direct.loginStatus();
  assert.equal(requests[2].url.searchParams.get('key'), 'pad-secret');
  assert.equal(new WechatPadClient({ baseUrl: 'http://pad.test' }).configured, false);
});

test('pad api: voice benign ret is endpoint-scoped and structured errors stay readable', () => {
  const voice = { Code: 200, Success: false, Data: { base_response: { ret: -104, errMsg: { str: '' } } } };
  assert.equal(normalizeEnvelope(voice, { endpoint: '/message/SendVoice' }).ok, true);
  for (const endpoint of ['', '/message/SendTextMessage', '/message/SendImageNewMessage', '/message/SendAppMessage']) {
    const result = normalizeEnvelope(voice, { endpoint });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ret=-104');
  }
  for (const data of [
    { base_response: { ret: -1, errMsg: { str: '账号已退出' } } },
    { isSendSuccess: false, base_response: { ret: -104 } },
    [{ ret: -104 }, { retCode: -2, errMsg: { str: '拒绝发送' } }],
  ]) {
    const result = normalizeEnvelope({ Code: 200, Data: data }, { endpoint: '/message/SendVoice' });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /\[object Object\]/);
  }
  assert.equal(normalizeEnvelope({ ...voice, Code: 500 }, { endpoint: '/message/SendVoice' }).ok, false);
  assert.equal(normalizeEnvelope({ Code: 200, Data: { ret: { value: 0 } } }).ok, true);
  assert.equal(normalizeEnvelope({ Code: 500, Message: { str: '上游拒绝' } }).error, 'Code=500: 上游拒绝');
});

test('pad api: nested send rejection overrides an outer success envelope', async (t) => {
  const failures = [
    { isSendSuccess: false, errMsg: 'send rejected' },
    { base_response: { ret: -1, errMsg: 'bad recipient' } },
    { chat_send_ret_list: [{ ret: '-2' }] },
    { isSendSuccess: true, chat_send_ret_list: [{ ret: 7 }] },
    [{ ret: 0 }, { isSendSuccess: false }],
  ];
  for (const data of failures) {
    assert.equal(normalizeEnvelope({ Code: 200, Success: true, Data: data }).ok, false);
  }
  assert.equal(normalizeEnvelope({ Code: 200, Success: false, Data: { isSendSuccess: true, base_response: { ret: '0' } } }).ok, true);
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    Code: 200, Success: true, Data: { isSendSuccess: false, errMsg: 'bad recipient' },
  }));
  const sender = new (await import('../host/outbound.js')).OutboundSender({
    client: new WechatPadClient({ baseUrl: 'http://bridge.test', apiPrefix: '/proxy', wxid: 'wxid_bot' }),
  });
  assert.deepEqual(await sender.sendReply('wxid_peer', 'hello'), { ok: false, delivered: 0, error: 'bad recipient' });
});

test('harness: reply text comes from text parts only, never reasoning', () => {
  const event = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '回答' }] } },
  };
  assert.equal(extractAssistantText(event), '回答');
  assert.equal(extractAssistantText({ type: 'assistant/message', data: { text: '纯文本' } }), '纯文本');
});

test('settings: read model hides the secret but reports its presence', () => {
  const model = panelReadModel({ ...resolveConfig({}), key: 'super-secret' });
  assert.equal(model.key, undefined);
  assert.equal(model.keyConfigured, true);
  assert.ok(!JSON.stringify(model).includes('super-secret'));
});

test('settings: entry lookup prefers own fiber, then the package name, then the patch id', () => {
  // A foreign entry whose fiber is not this plugin's must not win.
  const foreign = { fiber: { id: 'fiber-1' }, get: () => ({ entries: () => [{ id: 'other-entry', fiber: { id: 'fiber-2' } }] }) };
  assert.equal(resolveSettingsEntry(foreign).ns, 'wechatpad');

  // The Loader hands out a runtime fiber object whose uid identifies the entry.
  const fiber = { id: 'fiber-1', uid: 7 };
  // Settings keys on `options.id`, never on `entry.id` (the include path).
  const own = { fiber, get: () => ({ entries: () => [{ id: 'include:my-entry', options: { id: 'my-entry', name: '@dsh/wechatpad' }, fiber: { uid: 7, state: 2 } }] }) };
  assert.equal(resolveSettingsEntry(own).ns, 'my-entry', 'the include path must not become the namespace');

  const byName = { fiber: { id: 'fiber-1' }, get: () => ({ entries: () => [{ id: 'include:packed-entry', options: { id: 'packed-entry', name: '@dsh/wechatpad' } }] }) };
  assert.equal(resolveSettingsEntry(byName).ns, 'packed-entry');
});

test('config schema: every field is editable and only credentials are secrets', () => {
  const json = Config.toJSON();
  const refs = json.refs;
  const root = refs[json.uid];
  const fields = Object.entries(root.dict);
  assert.ok(fields.length >= 20, 'the form must expose the whole configuration');
  for (const [name, id] of fields) {
    assert.equal(refs[id]?.meta?.volatile, true, `${name} must be volatile so dsh Settings projects it`);
  }
  const secrets = new Set(['key', 'bridgeToken']);
  for (const name of secrets) {
    assert.equal(refs[root.dict[name]].meta.role, 'secret', `${name} must be redacted`);
    assert.equal(refs[root.dict[name]].meta.volatile, true, `${name} must still be editable`);
  }
  for (const [name, id] of fields) {
    if (secrets.has(name)) continue;
    assert.notEqual(refs[id]?.meta?.role, 'secret', `${name} must not be redacted`);
  }
  // The serialized tree must survive a second call (the patch applies every time).
  const again = Config.toJSON();
  const againRoot = again.refs[again.uid];
  assert.equal(Object.keys(againRoot.dict).length, fields.length);
});

test('config schema: settings redaction removes the key value but keeps its presence', async () => {
  const { redactSecrets } = await import('@deepseek-ai/dsh-settings');
  const json = Config.toJSON();
  const refs = json.refs;
  const root = refs[json.uid];
  const keyNode = refs[root.dict.key];
  const { value, secrets } = redactSecrets(keyNode, 'super-secret');
  assert.equal(value, undefined);
  assert.deepEqual(secrets, [{ path: [], set: true }]);
});

test('config: a volatile parsed Config reads back as plain runtime values', () => {
  // dsh hands the plugin the parsed Config, where every `volatile` field is a
  // live reference that later settings writes update in place. The runtime must
  // read through it — a missed `.get()` silently froze the bridge on start-up
  // defaults, and once produced a `"/[object Object]"` route path.
  const parsed = Config({ key: 'secret-key', baseUrl: 'http://127.0.0.1:9000', dmPolicy: 'open' });
  assert.equal(typeof parsed.baseUrl?.get, 'function', 'volatile fields arrive as references');
  const resolved = resolveConfig(parsed);
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:9000');
  assert.equal(resolved.key, 'secret-key');
  assert.equal(resolved.dmPolicy, 'open');
  assert.equal(resolved.webhookPath, '/wechatpad/callback');
  assert.equal(resolved.receiveMode, 'websocket');
  assert.equal(typeof resolved.webhookPath, 'string');
  // A plain object (hand-written patch, defaults) keeps working unchanged.
  assert.equal(resolveConfig({ baseUrl: 'http://x', key: 'k' }).baseUrl, 'http://x');
});

test('config: the secret is still redacted when the runtime config is normalized', () => {
  const parsed = Config({ key: 'secret-key' });
  const resolved = resolveConfig(parsed);
  const model = panelReadModel(resolved);
  assert.equal(model.key, undefined);
  assert.equal(model.keyConfigured, true);
  assert.ok(!JSON.stringify(model).includes('secret-key'));
});

test('settings read model: both credentials are write-only', () => {
  const model = panelReadModel(resolveConfig({ key: 'wx-key', bridgeToken: 'bridge-token', bridgeBaseUrl: 'http://127.0.0.1:8002' }));
  assert.equal(model.key, undefined);
  assert.equal(model.bridgeToken, undefined);
  assert.equal(model.keyConfigured, true);
  assert.equal(model.bridgeTokenConfigured, true);
  assert.equal(model.bridgeBaseUrl, 'http://127.0.0.1:8002');
  const serialized = JSON.stringify(model);
  assert.ok(!serialized.includes('wx-key'));
  assert.ok(!serialized.includes('bridge-token'));
});

test('settings: bridge subscription settings are editable from the panel', async () => {
  const { savePanelSettings } = await import('../host/settings-bridge.js');
  const writes = [];
  const ctx = {
    fiber: { uid: 5 },
    get: (name) => (name === 'settings'
      ? { describe: () => [{ ns: 'wechatpad', revision: 2 }], update: async (ns, patch) => writes.push({ ns, patch }) }
      : { entries: () => [{ id: 'include:wechatpad', options: { id: 'wechatpad', name: '@dsh/wechatpad' }, fiber: { uid: 5 } }] }),
  };
  await savePanelSettings({
    ctx,
    patch: { receiveMode: 'bridge', bridgeBaseUrl: 'http://127.0.0.1:8002', bridgeAccounts: 'wxid_fixture_bot', bridgeToken: 'tok' },
    expectedRevision: 2,
  });
  assert.deepEqual(writes[0], {
    ns: 'wechatpad',
    patch: { receiveMode: 'bridge', bridgeBaseUrl: 'http://127.0.0.1:8002', bridgeAccounts: 'wxid_fixture_bot', bridgeToken: 'tok' },
  });
});

test('inbound: group mention is detected on the raw body, before cleanup', () => {
  // The real Bridge payload carries no AtWxIDList, and its content always
  // contains "@" from the sender id (`...@openim:`). Detection therefore has to
  // read the raw body after the sender prefix and before cleanupText strips it.
  const build = (body) => ({
    msg_id: 1, msg_type: 1, create_time: 1792477217,
    from_user_name: { str: 'room_other@chatroom' },
    to_user_name: { str: 'user_example' },
    content: { str: `sender_fixture@openim:\n${body}` },
  });
  const identity = { selfWxid: 'wxid_fixture_bot', selfNickname: 'CC' };

  const mentioned = decodeMessage(build('@CC\u2005帮我看下'), identity);
  assert.equal(mentioned.mentioned, true);
  assert.equal(mentioned.text, '帮我看下');
  assert.equal(mentioned.chatId, 'room_other@chatroom');
  assert.equal(mentioned.senderId, 'sender_fixture@openim');

  // A longer name that merely starts with the bot's is not a mention.
  assert.equal(decodeMessage(build('@CCD\u2005别人'), identity).mentioned, false);
  assert.equal(decodeMessage(build('随便聊聊'), identity).mentioned, false);
  // @all is not an address to this bot.
  assert.equal(decodeMessage(build('@所有人\u2005通知'), identity).mentioned, false);
  // Without a known identity nothing can match, which is why the nickname is
  // resolved from the Bridge at startup.
  assert.equal(decodeMessage(build('@CC\u2005帮我看下'), {}).mentioned, false);
});

test('inbound: a mentioned group message passes the mention policy', () => {
  const config = resolveConfig({
    groupPolicy: 'allowlist', allowedGroups: ['room_other@chatroom'],
    groupRequireMention: true, selfNickname: 'CC', selfWxid: 'wxid_bot',
  });
  const identity = { selfWxid: 'wxid_bot', selfNickname: 'CC' };
  const build = (body) => ({
    msg_id: 3, msg_type: 1,
    from_user_name: { str: 'room_other@chatroom' },
    to_user_name: { str: 'user_example' },
    content: { str: `sender_fixture@openim:\n${body}` },
  });
  const hit = applyPolicy(decodeMessage(build('@CC\u2005在吗'), identity), config, 'wxid_bot');
  assert.equal(hit.allowed, true);
  const miss = applyPolicy(decodeMessage(build('路过'), identity), config, 'wxid_bot');
  assert.equal(miss.allowed, false);
  assert.equal(miss.reason, 'group-not-mentioned');
});

test('inbound: a WechatPad group mention decodes end to end', () => {
  // Example message: the in-group @ name is 「助手」 while the
  // account nickname is 「CC」, so text matching alone could never work. The
  // authoritative signal is <atuserlist> inside msg_source.
  const raw = {
    msg_id: 123456, status: 3, msg_type: 1, img_status: 1,
    content: { str: 'user_example:\n@助手\u2005 2' },
    img_buf: { len: 0 },
    msg_source: '<msgsource>\n\t<atuserlist>wxid_fixture_bot</atuserlist>\n\t<alnode>\n\t\t<fr>1</fr>\n\t</alnode>\n\t<silence>0</silence>\n\t<membercount>3</membercount>\n</msgsource>\n',
    new_msg_id: 1000000000000000001,
    create_time: 1700000000,
    push_content: '测试用户在群聊中@了你',
    to_user_name: { str: 'wxid_fixture_bot' },
    from_user_name: { str: 'room_fixture@chatroom' },
  };
  const identity = { selfWxid: 'wxid_fixture_bot', selfNickname: 'CC' };
  const message = decodeMessage(raw, identity);
  assert.equal(message.isGroup, true);
  assert.equal(message.chatId, 'room_fixture@chatroom');
  assert.equal(message.senderId, 'user_example');
  assert.equal(message.mentioned, true);
  assert.equal(message.text, '2');

  // The same message reaches a session once the group is allowlisted.
  const config = resolveConfig({
    groupPolicy: 'allowlist',
    allowedGroups: ['room_fixture@chatroom'],
    groupRequireMention: true,
    selfWxid: 'wxid_fixture_bot',
  });
  assert.equal(applyPolicy(message, config, 'wxid_fixture_bot').allowed, true);
});

test('inbound: atuserlist and the push notice are parsed independently', () => {
  assert.deepEqual(parseAtUserList('<msgsource><atuserlist>wxid_a,wxid_b</atuserlist></msgsource>'), ['wxid_a', 'wxid_b']);
  assert.deepEqual(parseAtUserList('<msgsource><atuserlist> wxid_a </atuserlist></msgsource>'), ['wxid_a']);
  assert.deepEqual(parseAtUserList('<msgsource></msgsource>'), []);
  assert.deepEqual(parseAtUserList(''), []);
  assert.equal(looksLikeMentionPush('测试用户在群聊中@了你'), true);
  assert.equal(looksLikeMentionPush('Someone mentioned you'), true);
  assert.equal(looksLikeMentionPush(''), false);
  assert.equal(looksLikeMentionPush('普通消息'), false);
});

test('config: provider defaults to pad so every existing profile keeps working', () => {
  // An old profile has no provider key at all: it must resolve to the Pad
  // adapter, never to an undefined adapter.
  assert.equal(resolveConfig({}).provider, 'pad');
  assert.equal(resolveConfig(Config({})).provider, 'pad');
  assert.equal(resolveConfig({ provider: 'weixin' }).provider, 'weixin');
  // A value a newer version might have written falls back rather than breaking.
  assert.equal(resolveConfig({ provider: 'matrix' }).provider, 'pad');
  assert.equal(resolveConfig({ provider: '  pad ' }).provider, 'pad');
  // Existing pad fields and their defaults are untouched.
  const resolved = resolveConfig({});
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:8059');
  assert.equal(resolved.receiveMode, 'websocket');
  assert.equal(resolved.webhookPath, '/wechatpad/callback');
  assert.equal(resolved.requestTimeoutSeconds, 20);
});

test('config: iLink fields normalize and never add a secret', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.weixinAccountFile, '');
  assert.equal(defaults.weixinTyping, true);
  assert.equal(defaults.weixinReplyQuote, true);
  assert.equal(defaults.weixinBotType, '3');
  // Booleans are read optimistically: only an explicit false turns them off.
  assert.equal(resolveConfig({ weixinTyping: false }).weixinTyping, false);
  assert.equal(resolveConfig({ weixinReplyQuote: false }).weixinReplyQuote, false);
  assert.equal(resolveConfig({ weixinTyping: undefined }).weixinTyping, true);
  // Strings are trimmed, and an empty bot type keeps the default.
  assert.equal(resolveConfig({ weixinAccountFile: '  /tmp/acc  ' }).weixinAccountFile, '/tmp/acc');
  assert.equal(resolveConfig({ weixinBotType: '  ' }).weixinBotType, '3');
  assert.equal(resolveConfig({ weixinBotType: ' 5 ' }).weixinBotType, '5');
  // The iLink token is not a config field: there is nothing to leak.
  const model = panelReadModel(resolveConfig({ provider: 'weixin' }));
  assert.ok(!('weixinToken' in model));
  assert.ok(!('token' in model));
});

test('config schema: new fields are editable and provider is a pad/weixin union', () => {
  const json = Config.toJSON();
  const root = json.refs[json.uid];
  for (const name of ['provider', 'weixinAccountFile', 'weixinTyping', 'weixinReplyQuote', 'weixinBotType']) {
    assert.ok(root.dict[name] !== undefined, `${name} must be declared`);
    assert.equal(json.refs[root.dict[name]].meta.volatile, true, `${name} must be volatile`);
    assert.equal(isEditableField(name), true, `${name} must be writable from the panel`);
  }
  // Only the two credentials stay secrets.
  const secrets = Object.entries(root.dict)
    .filter(([, id]) => json.refs[id]?.meta?.role === 'secret')
    .map(([name]) => name)
    .sort();
  assert.deepEqual(secrets, ['bridgeToken', 'key']);
});

test('settings: panel defaults are plain values, not volatile references', () => {
  // The panel renders an untouched field from `defaults`; a volatile number or
  // boolean read without `.get()` serializes as `{}` and renders an empty box.
  const defaults = resolveDefaults();
  assert.equal(defaults.provider, 'pad');
  assert.equal(defaults.requestTimeoutSeconds, 20);
  assert.equal(defaults.weixinTyping, true);
  assert.equal(defaults.weixinReplyQuote, true);
  assert.equal(defaults.weixinBotType, '3');
  assert.deepEqual(defaults.allowedUsers, []);
  // It crosses the RPC as JSON, so nothing may be lost on the way.
  assert.deepEqual(JSON.parse(JSON.stringify(defaults)), defaults);
  assert.equal(typeof defaults.enabled, 'boolean');
});

test('settings: provider is validated and reaches the write', async () => {
  const writes = [];
  const makeCtx = () => ({
    fiber: { uid: 9 },
    get: (name) => (name === 'settings'
      ? { describe: () => [{ ns: 'wechatpad', revision: 1 }], update: async (ns, patch) => writes.push({ ns, patch }) }
      : { entries: () => [{ id: 'include:wechatpad', options: { id: 'wechatpad', name: '@dsh/wechatpad' }, fiber: { uid: 9 } }] }),
  });
  await savePanelSettings({ ctx: makeCtx(), patch: { provider: 'weixin', weixinTyping: false }, expectedRevision: 1 });
  assert.deepEqual(writes.at(-1).patch, { provider: 'weixin', weixinTyping: false });
  // A typo is rejected before the Loader ever sees it.
  await assert.rejects(
    () => savePanelSettings({ ctx: makeCtx(), patch: { provider: 'wechatpad' }, expectedRevision: 1 }),
    /未知的接入方式/,
  );
});

test('settings: the panel defaults endpoint carries every field the page renders', () => {
  // `settings.get` hands the page `defaults` alongside the persisted values, so
  // an untouched control (the protocol select, the iLink switches) shows the
  // schema default instead of a blank box.
  const defaults = panelDefaults();
  for (const name of ['provider', 'weixinTyping', 'weixinReplyQuote', 'weixinBotType', 'requestTimeoutSeconds', 'receiveMode']) {
    assert.ok(name in defaults, `${name} must be in the panel defaults`);
  }
  assert.equal(defaults.provider, 'pad');
  assert.equal(defaults.weixinBotType, '3');
  // Everything must survive the JSON hop of the RPC.
  assert.deepEqual(JSON.parse(JSON.stringify(defaults)), defaults);
  // `resolveConfig({})` (what the service passes today) agrees on the new fields.
  const serviceDefaults = resolveConfig({});
  for (const name of ['provider', 'weixinTyping', 'weixinReplyQuote', 'weixinBotType']) {
    assert.deepEqual(serviceDefaults[name], defaults[name], `${name} must agree across the two default paths`);
  }
});
