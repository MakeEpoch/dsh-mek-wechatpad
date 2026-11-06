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
import { WechatPadClient } from '../host/pad-api.js';
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
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:8062');
  assert.equal(resolved.clientId, undefined);
  assert.equal(resolved.dmPolicy, 'allowlist');
  assert.equal(resolved.groupPolicy, 'disabled');
  assert.deepEqual(resolved.allowedUsers, []);
  assert.equal(resolved.token, '');
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
    baseUrl: 'http://127.0.0.1:8062///',
    apiPrefix: 'proxy/',
    webhookPath: 'hook',
    requestTimeoutSeconds: 999,
    maxReplyChunkLength: 1,
  });
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:8062');
  assert.equal(resolved.apiPrefix, undefined);
  assert.equal(resolved.webhookPath, undefined);
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

test('OneBot HTTP: single endpoint, Bearer auth and correlated standard receipt', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url: new URL(url), options, body });
    return Response.json({ status: 'ok', retcode: 0, data: { message_id: '9007199254740993', time: 1 }, message: '', echo: body.echo });
  });
  const client = new WechatPadClient({ baseUrl: 'http://pad.test', token: 'secret', wxid: 'bot' });
  const result = await client.sendText('room@chatroom', 'hello');
  assert.equal(result.ok, true); assert.equal(result.messageId, '9007199254740993');
  assert.equal(calls[0].url.pathname, '/'); assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(calls[0].body.self, { platform: 'wechat', user_id: 'bot' });
  assert.equal(calls[0].body.params.group_id, 'room@chatroom');
});

test('OneBot failed action is authoritative and an uncertain send is not retried', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    calls += 1; return Response.json({ status: 'failed', retcode: 34000, data: null, message: 'bad recipient', echo: JSON.parse(options.body).echo,
      'wechat.source': { provider: 'fixture', data: { ret: 0 } } });
  });
  const result = await new WechatPadClient({ baseUrl: 'http://pad.test', token: 't', wxid: 'bot' }).sendText('peer', 'hello');
  assert.equal(result.ok, false); assert.equal(result.error, 'bad recipient'); assert.equal(calls, 1);
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
  const model = panelReadModel({ ...resolveConfig({}), token: 'super-secret' });
  assert.equal(model.token, undefined);
  assert.equal(model.tokenConfigured, true);
  assert.ok(!JSON.stringify(model).includes('super-secret'));
});

test('settings: entry lookup prefers own fiber, then the package name, then the patch id', () => {
  // A foreign entry whose fiber is not this plugin's must not win.
  const foreign = { fiber: { id: 'fiber-1' }, get: () => ({ entries: () => [{ id: 'other-entry', fiber: { id: 'fiber-2' } }] }) };
  assert.equal(resolveSettingsEntry(foreign).ns, 'wechatpad');

  // The Loader hands out a runtime fiber object whose uid identifies the entry.
  const fiber = { id: 'fiber-1', uid: 7 };
  // Settings keys on `options.id`, never on `entry.id` (the include path).
  const own = { fiber, get: () => ({ entries: () => [{ id: 'include:my-entry', options: { id: 'my-entry', name: 'dsh-mek-wechatpad' }, fiber: { uid: 7, state: 2 } }] }) };
  assert.equal(resolveSettingsEntry(own).ns, 'my-entry', 'the include path must not become the namespace');

  const byName = { fiber: { id: 'fiber-1' }, get: () => ({ entries: () => [{ id: 'include:packed-entry', options: { id: 'packed-entry', name: 'dsh-mek-wechatpad' } }] }) };
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
  const secrets = new Set(['token']);
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
  const keyNode = refs[root.dict.token];
  const { value, secrets } = redactSecrets(keyNode, 'super-secret');
  assert.equal(value, undefined);
  assert.deepEqual(secrets, [{ path: [], set: true }]);
});

test('config: a volatile parsed Config reads back as plain runtime values', () => {
  // dsh hands the plugin the parsed Config, where every `volatile` field is a
  // live reference that later settings writes update in place. The runtime must
  // read through it — a missed `.get()` silently froze the bridge on start-up
  // defaults, and once produced a `"/[object Object]"` route path.
  const parsed = Config({ token: 'secret-key', baseUrl: 'http://127.0.0.1:9000', dmPolicy: 'open' });
  assert.equal(typeof parsed.baseUrl?.get, 'function', 'volatile fields arrive as references');
  const resolved = resolveConfig(parsed);
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:9000');
  assert.equal(resolved.token, 'secret-key');
  assert.equal(resolved.dmPolicy, 'open');
  assert.equal(resolved.webhookPath, undefined);
  assert.equal(resolved.clientId, undefined);
  assert.equal(typeof resolved.wxid, 'string');
  // A plain object (hand-written patch, defaults) keeps working unchanged.
  assert.equal(resolveConfig({ baseUrl: 'http://x', token: 'k' }).baseUrl, 'http://x');
});

test('config: the secret is still redacted when the runtime config is normalized', () => {
  const parsed = Config({ token: 'secret-key' });
  const resolved = resolveConfig(parsed);
  const model = panelReadModel(resolved);
  assert.equal(model.token, undefined);
  assert.equal(model.tokenConfigured, true);
  assert.ok(!JSON.stringify(model).includes('secret-key'));
});

test('settings read model: the sole service token is write-only', () => {
  const model = panelReadModel(resolveConfig({ token: 'service-secret', baseUrl: 'http://pad.test' }));
  assert.equal(model.token, undefined);
  assert.equal(model.tokenConfigured, true);
  assert.equal(model.baseUrl, 'http://pad.test');
  assert.ok(!JSON.stringify(model).includes('service-secret'));
});

test('settings: bridge subscription settings are editable from the panel', async () => {
  const { savePanelSettings } = await import('../host/settings-bridge.js');
  const writes = [];
  const ctx = {
    fiber: { uid: 5 },
    get: (name) => (name === 'settings'
      ? { describe: () => [{ ns: 'wechatpad', revision: 2 }], update: async (ns, patch) => writes.push({ ns, patch }) }
      : { entries: () => [{ id: 'include:wechatpad', options: { id: 'wechatpad', name: 'dsh-mek-wechatpad' }, fiber: { uid: 5 } }] }),
  };
  await savePanelSettings({
    ctx,
    patch: { baseUrl: 'http://127.0.0.1:8062', wxid: 'wxid_fixture_bot', token: 'tok' },
    expectedRevision: 2,
  });
  assert.deepEqual(writes[0], {
    ns: 'wechatpad',
    patch: { baseUrl: 'http://127.0.0.1:8062', wxid: 'wxid_fixture_bot', token: 'tok' },
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
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:8062');
  assert.equal(resolved.clientId, undefined);
  assert.equal(resolved.webhookPath, undefined);
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
  assert.equal(model.token, undefined);
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
  assert.deepEqual(secrets, ['token']);
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
      : { entries: () => [{ id: 'include:wechatpad', options: { id: 'wechatpad', name: 'dsh-mek-wechatpad' }, fiber: { uid: 9 } }] }),
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
  for (const name of ['provider', 'weixinTyping', 'weixinReplyQuote', 'weixinBotType', 'requestTimeoutSeconds', 'wxid']) {
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
