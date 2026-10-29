/**
 * iLink 协议层与账号状态的离线测试。
 *
 * 全部走注入的假 fetch，不联网；状态文件写到临时 DSH_HOME 里，跑完即删。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'wechatpad-weixin-'));
process.env.DSH_HOME = home;
test.after(async () => { await rm(home, { recursive: true, force: true }); });

const {
  DEFAULT_WEIXIN_MAX_MESSAGE_CHARS,
  DEFAULT_BOT_TYPE,
  WEIXIN_CDN_BASE_URL,
  WEIXIN_PROTOCOL_VERSION,
  WEIXIN_QR_BASE_URL,
  WeixinApiError,
  authenticatedHeaders,
  commonHeaders,
  createWeixinApi,
  extractWeixinReplyReference,
  extractWeixinText,
  isWeixinHost,
  normalizeWeixinApiBaseUrl,
  orderWeixinMessages,
  splitWeixinText,
  weixinMessageId,
  weixinMessageTimestampMs,
} = await import('../host/weixin-api.js');
const {
  WEIXIN_CONTEXT_TOKEN_LIMIT,
  WEIXIN_RECENT_OUTBOUND_LIMIT,
  WEIXIN_SEEN_MESSAGE_LIMIT,
  WeixinAccountState,
  WeixinStateError,
} = await import('../host/weixin-state.js');

const BASE = 'https://ilinkai.weixin.qq.com/';
const TOKEN = 'bot-token-abc';

/**
 * 构造一个按序返回预设响应的假 fetch，并记录每次调用。
 * @param {Array<object|Error|((url: URL, init: object) => object|Promise<object>)>} steps
 */
function fakeFetch(steps) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    calls.push({ url: parsed, init });
    const step = steps.length > 1 ? steps.shift() : steps[0];
    if (typeof step === 'function') return step(parsed, init);
    if (step instanceof Error) throw step;
    const { status = 200, body = {}, headers = {} } = step;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      json: async () => {
        if (typeof body === 'function') return body();
        return body;
      },
    };
  };
  return { fetchImpl, calls };
}

/** 一个只会挂起直到超时的 fetch，用来模拟长轮询无新消息。 */
function hangingFetch() {
  const calls = [];
  const fetchImpl = (url, init = {}) => {
    calls.push({ url: url instanceof URL ? url : new URL(String(url)), init });
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  return { fetchImpl, calls };
}

test('常量与头部：iLink 协议指纹符合 2.4.6', () => {
  assert.equal(WEIXIN_QR_BASE_URL, 'https://ilinkai.weixin.qq.com/');
  assert.equal(WEIXIN_PROTOCOL_VERSION, '2.4.6');
  assert.equal(DEFAULT_BOT_TYPE, '3');
  assert.equal(WEIXIN_CDN_BASE_URL, 'https://novac2c.cdn.weixin.qq.com/c2c');
  assert.equal(DEFAULT_WEIXIN_MAX_MESSAGE_CHARS, 1800);

  const common = commonHeaders();
  assert.equal(common['iLink-App-Id'], 'bot');
  assert.equal(common['iLink-App-ClientVersion'], String((2 << 16) | (4 << 8) | 6));
  assert.equal(common.Authorization, undefined);

  const auth = authenticatedHeaders(TOKEN);
  assert.equal(auth.Authorization, `Bearer ${TOKEN}`);
  assert.equal(auth.AuthorizationType, 'ilink_bot_token');
  assert.equal(auth['content-type'], 'application/json');
  const uin = Buffer.from(auth['X-WECHAT-UIN'], 'base64').toString('utf8');
  assert.match(uin, /^\d{1,10}$/);
});

test('主机校验：只信任微信域，端口限 443，拒绝 untrusted-*', () => {
  assert.equal(isWeixinHost('weixin.qq.com'), true);
  assert.equal(isWeixinHost('ilinkai.weixin.qq.com'), true);
  assert.equal(isWeixinHost('WECHAT.COM'), true);
  assert.equal(isWeixinHost('liteapp.weixin.qq.com'), true);
  assert.equal(isWeixinHost('untrusted-weixin.qq.com'), false);
  assert.equal(isWeixinHost('weixin.qq.com.evil.io'), false);
  assert.equal(isWeixinHost('evil.io'), false);

  assert.equal(normalizeWeixinApiBaseUrl('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com/');
  assert.equal(
    normalizeWeixinApiBaseUrl('https://ilinkai.weixin.qq.com/api/v1?x=1#frag'),
    'https://ilinkai.weixin.qq.com/api/v1/',
  );
  assert.equal(normalizeWeixinApiBaseUrl('https://ilinkai.weixin.qq.com:443/'), 'https://ilinkai.weixin.qq.com/');
  for (const bad of [
    'http://ilinkai.weixin.qq.com/',
    'https://untrusted-example.weixin.qq.com/',
    'https://evil.io/',
    'https://ilinkai.weixin.qq.com:8443/',
    'https://user:pw@ilinkai.weixin.qq.com/',
    'not a url',
  ]) {
    assert.throws(() => normalizeWeixinApiBaseUrl(bad), (error) => {
      assert.ok(error instanceof WeixinApiError);
      assert.ok(['invalid-base-url', 'untrusted-base-url'].includes(error.code), error.code);
      return true;
    }, bad);
  }
});

test('beginLogin 走 bot_type=3，返回令牌与可信扫码地址', async () => {
  const { fetchImpl, calls } = fakeFetch([{
    body: { qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=qr-1&bot_type=3' },
  }]);
  const api = createWeixinApi({ fetchImpl });
  const result = await api.beginLogin({ localTokens: ['a', 'a', ' b '] });

  assert.equal(result.qrcode, 'qr-1');
  assert.match(result.qrcodeUrl, /^https:\/\/liteapp\.weixin\.qq\.com\//);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, `${BASE}ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.local_token_list, ['a', 'b']);
  assert.deepEqual(body.base_info, { channel_version: '2.4.6', bot_agent: 'DeepSeekHarness/1.1.0' });
});

test('beginLogin 拒绝非可信扫码地址与服务端错误码', async () => {
  const bad = fakeFetch([{ body: { qrcode: 'q', qrcode_img_content: 'https://evil.io/qr' } }]);
  await assert.rejects(createWeixinApi({ fetchImpl: bad.fetchImpl }).beginLogin({}), { code: 'untrusted-qr' });

  const rejected = fakeFetch([{ body: { ret: -3, qrcode: 'q', qrcode_img_content: 'https://liteapp.weixin.qq.com/q' } }]);
  await assert.rejects(createWeixinApi({ fetchImpl: rejected.fetchImpl }).beginLogin({}), (error) => {
    assert.equal(error.code, 'qr-request-rejected');
    assert.equal(error.providerCode, '-3');
    return true;
  });
});

test('pollLogin 校验扫码状态且在 wait 时如实返回', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { body: { status: 'wait' } },
    { body: { status: 'need_verifycode' } },
    { body: { status: 'bogus' } },
  ]);
  const api = createWeixinApi({ fetchImpl });
  assert.deepEqual(await api.pollLogin({ qrcode: 'qr-1' }), { status: 'wait' });
  assert.equal(calls[0].url.pathname, '/ilink/bot/get_qrcode_status');
  assert.equal(calls[0].url.searchParams.get('qrcode'), 'qr-1');
  // 扫码轮询不鉴权。
  assert.equal(calls[0].init.headers.Authorization, undefined);

  assert.equal((await api.pollLogin({ qrcode: 'qr-1', verifyCode: '1234' })).status, 'need_verifycode');
  assert.equal(calls[1].url.searchParams.get('verify_code'), '1234');

  await assert.rejects(api.pollLogin({ qrcode: 'qr-1' }), { code: 'invalid-login-status' });
  await assert.rejects(api.pollLogin({}), TypeError);
});

test('pollLogin 对 expand 重定向沿用服务端下发的 baseUrl', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { status: 'scaned_but_redirect', redirect_host: 'ilinkai.weixin.qq.com' } }]);
  const api = createWeixinApi({ fetchImpl });
  assert.equal(
    (await api.pollLogin({ qrcode: 'qr-9', baseUrl: 'https://ilinkai.weixin.qq.com/v2/' })).status,
    'scaned_but_redirect',
  );
  assert.equal(calls[0].url.origin, 'https://ilinkai.weixin.qq.com');
  assert.equal(calls[0].url.pathname, '/v2/ilink/bot/get_qrcode_status');
});

test('getUpdates 正常返回消息，请求头带 bot token 与协议版本', async () => {
  const payload = { ret: 0, msgs: [{ message_id: 'm1', seq: 2 }], get_updates_buf: 'buf-2' };
  const { fetchImpl, calls } = fakeFetch([{ body: payload }]);
  const api = createWeixinApi({ fetchImpl });
  const result = await api.getUpdates({ baseUrl: BASE, token: TOKEN, getUpdatesBuf: 'buf-1' });

  assert.deepEqual(result, payload);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers['iLink-App-Id'], 'bot');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.get_updates_buf, 'buf-1');
  assert.equal(body.base_info.channel_version, '2.4.6');
});

test('getUpdates 超时返回空批次而不是抛错', async () => {
  const { fetchImpl } = hangingFetch();
  const api = createWeixinApi({ fetchImpl });
  const result = await api.getUpdates({ baseUrl: BASE, token: TOKEN, getUpdatesBuf: 'buf-7', timeoutMs: 30 });
  assert.deepEqual(result, { ret: 0, msgs: [], get_updates_buf: 'buf-7' });
});

test('getUpdates 的非超时错误照常抛出并被分类', async () => {
  const { fetchImpl } = fakeFetch([{ status: 502, body: {} }]);
  await assert.rejects(createWeixinApi({ fetchImpl }).getUpdates({ baseUrl: BASE, token: TOKEN }), (error) => {
    assert.equal(error.code, 'http-error');
    assert.equal(error.status, 502);
    assert.equal(typeof error.durationMs, 'number');
    return true;
  });

  const broken = fakeFetch([{ body: () => { throw new Error('bad json'); } }]);
  await assert.rejects(createWeixinApi({ fetchImpl: broken.fetchImpl }).getUpdates({ baseUrl: BASE, token: TOKEN }), {
    code: 'invalid-response',
  });

  const offline = fakeFetch([new TypeError('fetch failed')]);
  await assert.rejects(createWeixinApi({ fetchImpl: offline.fetchImpl }).getUpdates({ baseUrl: BASE, token: TOKEN }), {
    code: 'network-error',
  });
});

test('sendText 成功时携带 client_id 与文本项，且 context_token 原样带上', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { ret: 0 } }]);
  const api = createWeixinApi({ fetchImpl });
  const result = await api.sendText({
    baseUrl: BASE,
    token: TOKEN,
    toUserId: 'user-1',
    text: '你好',
    contextToken: 'ctx-1',
    runId: 'run-1',
  });

  const { msg } = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url.pathname, '/ilink/bot/sendmessage');
  assert.equal(msg.from_user_id, '');
  assert.equal(msg.to_user_id, 'user-1');
  assert.equal(msg.message_type, 2);
  assert.equal(msg.message_state, 2);
  assert.deepEqual(msg.item_list, [{ type: 1, text_item: { text: '你好' } }]);
  assert.equal(msg.context_token, 'ctx-1');
  assert.equal(msg.run_id, 'run-1');
  assert.match(msg.client_id, /^dsh-wechatpad-[0-9a-f-]{36}$/);
  assert.deepEqual(result.providerMessageIds, [msg.client_id]);
});

test('sendText 在 ret / errcode 非 0 时抛 send-rejected 并带 providerCode', async () => {
  for (const body of [{ ret: -1 }, { ret: 0, errcode: 40001 }]) {
    const { fetchImpl } = fakeFetch([{ body }]);
    await assert.rejects(
      createWeixinApi({ fetchImpl }).sendText({ baseUrl: BASE, token: TOKEN, toUserId: 'u', text: 'x' }),
      (error) => {
        assert.equal(error.code, 'send-rejected');
        assert.equal(error.providerCode, String(body.ret !== 0 ? body.ret : body.errcode));
        return true;
      },
    );
  }
});

test('ret=-14 映射为 stale-token（notifyStart / testConnection）', async () => {
  const start = fakeFetch([{ body: { ret: -14 } }]);
  const api = createWeixinApi({ fetchImpl: start.fetchImpl });
  await assert.rejects(api.notifyStart({ baseUrl: BASE, token: TOKEN }), (error) => {
    assert.equal(error.code, 'stale-token');
    assert.equal(error.providerCode, '-14');
    return true;
  });

  const probe = fakeFetch([{ body: { ret: -14 } }]);
  const probeResult = await createWeixinApi({ fetchImpl: probe.fetchImpl }).testConnection({ baseUrl: BASE, token: TOKEN });
  assert.equal(probeResult.ok, false);
  assert.equal(probeResult.error.code, 'stale-token');
});

test('notifyStart/notifyStop 正常时返回原始响应', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { ret: 0 } }]);
  const api = createWeixinApi({ fetchImpl });
  assert.deepEqual(await api.notifyStart({ baseUrl: BASE, token: TOKEN }), { ret: 0 });
  assert.deepEqual(await api.notifyStop({ baseUrl: BASE, token: TOKEN }), { ret: 0 });
  assert.equal(calls[0].url.pathname, '/ilink/bot/msg/notifystart');
  assert.equal(calls[1].url.pathname, '/ilink/bot/msg/notifystop');
});

test('testConnection 探针在连通时返回 ok 与延迟', async () => {
  const { fetchImpl } = fakeFetch([{ body: { ret: 0, msgs: [] } }]);
  const result = await createWeixinApi({ fetchImpl }).testConnection({ baseUrl: BASE, token: TOKEN });
  assert.equal(result.ok, true);
  assert.equal(typeof result.latencyMs, 'number');

  const refused = fakeFetch([new TypeError('fetch failed')]);
  const failed = await createWeixinApi({ fetchImpl: refused.fetchImpl }).testConnection({ baseUrl: BASE, token: TOKEN });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'network-error');
});

test('getConfig / sendTyping 的参数校验与状态约束', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { ret: 0, typing_ticket: 'tick-1' } }, { body: { ret: 0 } }]);
  const api = createWeixinApi({ fetchImpl });
  assert.deepEqual(await api.getConfig({ baseUrl: BASE, token: TOKEN, toUserId: 'u1' }), { typingTicket: 'tick-1' });
  assert.equal(JSON.parse(calls[0].init.body).ilink_user_id, 'u1');

  assert.equal(await api.sendTyping({ baseUrl: BASE, token: TOKEN, toUserId: 'u1', typingTicket: 'tick-1', status: 1 }), true);
  const typingBody = JSON.parse(calls[1].init.body);
  assert.equal(typingBody.status, 1);
  assert.equal(typingBody.typing_ticket, 'tick-1');

  await assert.rejects(api.sendTyping({ baseUrl: BASE, token: TOKEN, toUserId: 'u1', typingTicket: 't', status: 3 }), TypeError);
  await assert.rejects(api.getConfig({ baseUrl: BASE, token: TOKEN }), TypeError);
});

test('requestJson 拒绝非微信主机，且客户端对象被冻结', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { ret: 0 } }]);
  const api = createWeixinApi({ fetchImpl });
  assert.equal(Object.isFrozen(api), true);
  await assert.rejects(
    api.getUpdates({ baseUrl: 'https://evil.io/', token: TOKEN }),
    { code: 'untrusted-base-url' },
  );
  assert.equal(calls.length, 0);
});

test('AbortSignal 取消会原样抛出中断原因', async () => {
  const { fetchImpl } = hangingFetch();
  const api = createWeixinApi({ fetchImpl });
  const controller = new AbortController();
  const reason = new Error('stop now');
  const pending = api.getUpdates({ baseUrl: BASE, token: TOKEN, timeoutMs: 5000, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test('extractWeixinText：type1 文本、type3 语音转写', () => {
  assert.equal(extractWeixinText({ item_list: [{ type: 1, text_item: { text: '  hi  ' } }] }), 'hi');
  assert.equal(extractWeixinText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }), '语音转写');
  assert.equal(extractWeixinText({ item_list: [{ type: 2, image_item: {} }] }), null);
  assert.equal(extractWeixinText({}), null);
  assert.equal(extractWeixinText(null), null);
});

test('weixinMessageId：优先 message_id，退回 client_id', () => {
  assert.equal(weixinMessageId({ message_id: 7400000000000000001n }), '7400000000000000001');
  assert.equal(weixinMessageId({ message_id: 'm-1', client_id: 'c-1' }), 'm-1');
  assert.equal(weixinMessageId({ client_id: 'c-1' }), 'c-1');
  assert.equal(weixinMessageId({}), null);
});

test('weixinMessageTimestampMs：右移 22 位取毫秒并做区间校验', () => {
  const now = Date.UTC(2026, 9, 20);
  const when = Date.UTC(2025, 0, 2, 3, 4, 5, 6);
  const id = (BigInt(when) << 22n) | 123n;
  assert.equal(weixinMessageTimestampMs(String(id), { now }), when);
  // 2020 年之前不可信。
  assert.equal(weixinMessageTimestampMs(String(BigInt(Date.UTC(2019, 5, 1)) << 22n), { now }), null);
  // 超过 now + 24h 不可信。
  assert.equal(weixinMessageTimestampMs(String(BigInt(now + 48 * 3600_000) << 22n), { now }), null);
  assert.equal(weixinMessageTimestampMs('abc', { now }), null);
  assert.equal(weixinMessageTimestampMs(null, { now }), null);
  // client_id 这类非数字 id 不能当成时间戳。
  assert.equal(weixinMessageTimestampMs('dsh-wechatpad-1234', { now }), null);
});

test('orderWeixinMessages：按 seq 排序且保持稳定', () => {
  const input = [
    { seq: 3, id: 'c' },
    { seq: 1, id: 'a' },
    { seq: 2, id: 'b1' },
    { seq: 2, id: 'b2' },
  ];
  assert.deepEqual(orderWeixinMessages(input).map((m) => m.id), ['a', 'b1', 'b2', 'c']);

  const byTime = [{ create_time_ms: 200 }, { create_time_ms: 100 }];
  assert.deepEqual(orderWeixinMessages(byTime), [{ create_time_ms: 100 }, { create_time_ms: 200 }]);

  // 缺 seq 时退回 create_time_ms。
  const mixed = [{ create_time_ms: 9 }, { seq: 1, create_time_ms: 1 }];
  assert.equal(orderWeixinMessages(mixed)[0].create_time_ms, 1);

  // 两个字段都不全则保持原序。
  const unordered = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(orderWeixinMessages(unordered), unordered);
  assert.deepEqual(orderWeixinMessages(null), []);
});

test('splitWeixinText：换行切点、60% 下限、超长硬切', () => {
  assert.deepEqual(splitWeixinText('short'), ['short']);
  assert.deepEqual(splitWeixinText(''), []);
  assert.deepEqual(splitWeixinText('abcdefghij', 100), ['abcdefghij']);

  // 换行在上限附近：在换行处断开。
  const nearBreak = `${'a'.repeat(30)}\n${'b'.repeat(30)}`;
  assert.deepEqual(splitWeixinText(nearBreak, 40), ['a'.repeat(30), 'b'.repeat(30)]);

  // 换行太靠前（< 60%）：放弃换行，硬切在上限处。
  const earlyBreak = `${'a'.repeat(5)}\n${'b'.repeat(60)}`;
  const chunks = splitWeixinText(earlyBreak, 40);
  assert.equal(chunks.length, 2);
  // 换行在 5 处（< 40 * 0.6 = 24），放弃换行改在 40 处硬切。
  assert.equal(chunks[0], `${'a'.repeat(5)}\n${'b'.repeat(34)}`);
  assert.equal(chunks[0].length, 40);
  assert.ok(chunks.every((chunk) => chunk.length <= 40));
  assert.equal(chunks.join(''), earlyBreak, '硬切不丢内容');
  assert.equal(chunks[1], 'b'.repeat(26));

  // 纯长文本按上限切，且不丢内容。
  const long = 'x'.repeat(5000);
  const parts = splitWeixinText(long, 1000);
  assert.equal(parts.length, 5);
  assert.equal(parts.join(''), long);
  assert.ok(parts.every((part) => part.length <= 1000));

  // 默认上限 1800。
  const defaults = splitWeixinText('y'.repeat(2000));
  assert.equal(defaults.length, 2);
  assert.ok(defaults.every((part) => part.length <= 1800));
});

test('extractWeixinReplyReference：文本引用、附件引用与兜底', () => {
  const textRef = extractWeixinReplyReference({
    item_list: [{ type: 1, ref_msg: { message_item: { type: 1, msg_id: 'm-9', text_item: { text: '原文' } } } }],
  });
  assert.deepEqual(textRef, { messageId: 'm-9', content: '原文' });

  const imageRef = extractWeixinReplyReference({
    item_list: [{ ref_msg: { message_item: { type: 2, image_item: {} } } }],
  });
  assert.deepEqual(imageRef, { attachments: [{ kind: 'image' }] });

  const fileRef = extractWeixinReplyReference({
    item_list: [{ ref_msg: { message_item: { type: 4, file_item: { file_name: 'a.pdf' } } } }],
  });
  assert.deepEqual(fileRef, { attachments: [{ kind: 'file', name: 'a.pdf' }] });

  const unresolved = extractWeixinReplyReference({ item_list: [{ ref_msg: {} }] });
  assert.deepEqual(unresolved, { unavailableReason: 'not-delivered' });

  const resolved = extractWeixinReplyReference(
    { item_list: [{ ref_msg: { message_item: { msg_id: 'm-3' } } }] },
    { resolveContent: () => '找回的原文' },
  );
  assert.deepEqual(resolved, { messageId: 'm-3', content: '找回的原文' });

  assert.equal(extractWeixinReplyReference({ item_list: [] }), null);
});

test('WeixinAccountState：原子写、权限与损坏文件回退', async () => {
  const botId = 'bot-atomic';
  const state = new WeixinAccountState(botId);
  assert.equal(state.path, join(home, 'wechatpad', 'weixin-accounts', `${botId}.json`));

  await state.load();
  await state.setSession('chat-1', 'session-1');
  assert.equal(state.sessionFor('chat-1'), 'session-1');

  const raw = await readFile(state.path, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  // 临时文件已 rename 掉，目录里只剩正式文件。
  const fileStat = await stat(state.path);
  assert.equal(fileStat.mode & 0o777, 0o600);
  const dirStat = await stat(join(home, 'wechatpad', 'weixin-accounts'));
  assert.equal(dirStat.mode & 0o777, 0o700);

  // 重新加载能读回原状态。
  const reloaded = new WeixinAccountState(botId);
  await reloaded.load();
  assert.equal(reloaded.sessionFor('chat-1'), 'session-1');

  // 损坏 JSON → 空态并重建。
  await writeFile(state.path, '{ not json', 'utf8');
  const repaired = new WeixinAccountState(botId);
  await repaired.load();
  assert.equal(repaired.sessionFor('chat-1'), null);
  assert.equal(repaired.getUpdatesBuf(), '');
  const rebuilt = JSON.parse(await readFile(state.path, 'utf8'));
  assert.equal(rebuilt.version, 1);
  assert.deepEqual(rebuilt.sessions, {});

  // ENOENT 视为空态。
  await rm(state.path);
  const fresh = new WeixinAccountState(botId);
  await fresh.load();
  assert.equal(await fresh.hasSeen('m1'), false);
});

test('WeixinAccountState：contextToken 旧序号不覆盖新序号', async () => {
  const state = new WeixinAccountState('bot-ctx');
  await state.load();
  await state.bindContextTokens(TOKEN);

  assert.equal(await state.rememberContextToken({ userId: 'u1', contextToken: 'ctx-5', seq: 5, messageTimeMs: 500 }), true);
  assert.equal(state.contextTokenFor('u1'), 'ctx-5');

  // 旧序号一律忽略。
  assert.equal(await state.rememberContextToken({ userId: 'u1', contextToken: 'ctx-3', seq: 3, messageTimeMs: 300 }), false);
  assert.equal(state.contextTokenFor('u1'), 'ctx-5');

  // 同序号不覆盖。
  assert.equal(await state.rememberContextToken({ userId: 'u1', contextToken: 'ctx-5b', seq: 5 }), false);
  assert.equal(state.contextTokenFor('u1'), 'ctx-5');

  // 序号缺失但时间更旧：同样不覆盖。
  assert.equal(await state.rememberContextToken({ userId: 'u1', contextToken: 'ctx-4', messageTimeMs: 400 }), false);
  assert.equal(state.contextTokenFor('u1'), 'ctx-5');

  // 新序号覆盖。
  assert.equal(await state.rememberContextToken({ userId: 'u1', contextToken: 'ctx-6', seq: 6, messageTimeMs: 600 }), true);
  assert.equal(state.contextTokenFor('u1'), 'ctx-6');

  // 超过 64 位安全整数范围的序号按字符串比较，仍然正确。
  await state.rememberContextToken({ userId: 'u2', contextToken: 'big-2', seq: '18446744073709551617' });
  assert.equal(
    await state.rememberContextToken({ userId: 'u2', contextToken: 'big-1', seq: '18446744073709551616' }),
    false,
  );
  assert.equal(state.contextTokenFor('u2'), 'big-2');

  // token 变了：context_token 整表作废。
  assert.equal(await state.bindContextTokens('another-token'), true);
  assert.equal(state.contextTokenFor('u1'), undefined);
  assert.equal(await state.bindContextTokens('another-token'), false);
});

test('WeixinAccountState：contextToken 超上限淘汰最旧用户', async () => {
  const state = new WeixinAccountState('bot-ctx-evict');
  await state.load();
  await state.bindContextTokens(TOKEN);
  for (let index = 0; index <= WEIXIN_CONTEXT_TOKEN_LIMIT; index += 1) {
    await state.rememberContextToken({ userId: `u${index}`, contextToken: `ctx-${index}`, seq: index });
  }
  assert.equal(state.contextTokenFor('u0'), undefined);
  assert.equal(state.contextTokenFor(`u${WEIXIN_CONTEXT_TOKEN_LIMIT}`), `ctx-${WEIXIN_CONTEXT_TOKEN_LIMIT}`);
  assert.equal(state.contextTokenFor('u1'), 'ctx-1');
});

test('WeixinAccountState：snapshot/status 不泄露任何 token', async () => {
  const state = new WeixinAccountState('bot-secret');
  await state.load();
  await state.bindContextTokens(TOKEN);
  await state.rememberContextToken({ userId: 'u1', contextToken: 'ctx-secret-value', seq: 1 });
  await state.setSession('chat', 'session');
  await state.setAccount({ accountId: 'bot-1', ownerUserId: 'owner-1', baseUrl: BASE });

  const snapshot = state.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.contextTokens, undefined, 'snapshot 不带 contextTokens');
  assert.ok(!serialized.includes('ctx-secret-value'));
  assert.ok(!serialized.includes(TOKEN));
  // 账号元信息可以出现在 snapshot 里，但不含任何凭证。
  assert.equal(snapshot.account.accountId, 'bot-1');
  assert.ok(!serialized.includes('credentialHash'));

  const status = state.status();
  const statusJson = JSON.stringify(status);
  assert.ok(!statusJson.includes('ctx-secret-value'));
  assert.ok(!statusJson.includes(TOKEN));
  assert.equal(status.hasContextTokens, 'yes');
  assert.equal(status.botIdHash, state.botIdHash);
  assert.match(status.botIdHash, /^[a-f0-9]{12}$/);
  assert.ok(!statusJson.includes('bot-secret'));

  // 落盘文件同样不写入 token（只有 context_token 与会话绑定）。
  const raw = await readFile(state.path, 'utf8');
  assert.ok(!raw.includes(TOKEN));
  assert.ok(raw.includes('ctx-secret-value'));
});

test('WeixinAccountState：去重、游标、会话与出站记录', async () => {
  const state = new WeixinAccountState('bot-misc');
  await state.load();

  assert.equal(await state.hasSeen('m1'), false);
  assert.equal(await state.markSeen('m1'), true);
  assert.equal(await state.markSeen('m1'), false);
  assert.equal(await state.hasSeen('m1'), true);

  assert.equal(await state.setGetUpdatesBuf('buf-1'), true);
  assert.equal(state.getUpdatesBuf(), 'buf-1');
  assert.equal(await state.setGetUpdatesBuf('buf-1'), false);
  assert.equal(await state.setGetUpdatesBuf(undefined), false);

  await state.setSession('chat-a', 'session-a');
  await state.setSession('chat-b', 'session-b');
  await state.clearSession('chat-a');
  assert.equal(state.sessionFor('chat-a'), null);
  assert.deepEqual(state.sessions(), { 'chat-b': 'session-b' });
  await state.clearSessions();
  assert.deepEqual(state.sessions(), {});

  const now = Date.now();
  await state.rememberOutboundMessage({
    toUserId: 'u1',
    text: '我们发出的原文',
    sentAt: now - 1000,
    completedAt: now,
    providerMessageIds: ['dsh-wechatpad-x'],
  });
  assert.equal(state.recentOutboundTextFor({ toUserId: 'u1', messageId: 'dsh-wechatpad-x' }), '我们发出的原文');
  assert.equal(state.recentOutboundTextFor({ toUserId: 'u1', createTimeMs: now }), '我们发出的原文');
  assert.equal(state.recentOutboundTextFor({ toUserId: 'other', messageId: 'dsh-wechatpad-x' }), null);
  assert.equal(state.recentOutboundTextFor({ toUserId: 'u1' }), null);
  assert.equal(state.recentOutboundTextFor({ toUserId: 'u1', messageId: 'nope' }), null);

  // 过期的出站记录不再命中。
  assert.equal(
    state.recentOutboundTextFor({ toUserId: 'u1', messageId: 'dsh-wechatpad-x', now: now + 31 * 24 * 3600_000 }),
    null,
  );

  await assert.rejects(state.rememberOutboundMessage({ toUserId: 'u1' }), TypeError);
});

test('WeixinAccountState：seenMessageIds 裁剪到 1000 条，出站记录裁剪到 200 条', async () => {
  const state = new WeixinAccountState('bot-limits');
  await state.load();
  for (let index = 0; index < WEIXIN_SEEN_MESSAGE_LIMIT + 5; index += 1) await state.markSeen(`m${index}`);
  const snapshot = state.snapshot();
  assert.equal(snapshot.seenMessageIds.length, WEIXIN_SEEN_MESSAGE_LIMIT);
  assert.equal(snapshot.seenMessageIds.at(-1), `m${WEIXIN_SEEN_MESSAGE_LIMIT + 4}`);

  const now = Date.now();
  for (let index = 0; index < WEIXIN_RECENT_OUTBOUND_LIMIT + 3; index += 1) {
    await state.rememberOutboundMessage({ toUserId: 'u1', text: `t${index}`, sentAt: now + index, completedAt: now + index });
  }
  assert.equal(state.snapshot().recentOutboundMessages.length, WEIXIN_RECENT_OUTBOUND_LIMIT);
});

test('WeixinAccountState：load 遇到不可读路径抛状态错误', async () => {
  await mkdir(join(home, 'wechatpad'), { recursive: true });
  // 用目录冒充状态文件，读取时得到 EISDIR 而非 ENOENT。
  await mkdir(join(home, 'wechatpad', 'weixin-accounts', 'blocked.json'), { recursive: true });
  const state = new WeixinAccountState('blocked');
  await assert.rejects(state.load(), (error) => {
    assert.ok(error instanceof WeixinStateError);
    assert.equal(error.code, 'state-read-failed');
    return true;
  });
});

test('WeixinAccountState：remove 清空文件与内存状态', async () => {
  const state = new WeixinAccountState('bot-remove');
  await state.load();
  await state.setSession('chat', 'session');
  await state.remove();
  assert.equal(state.sessionFor('chat'), null);
  await assert.rejects(stat(state.path), { code: 'ENOENT' });
  // 重复删除不报错。
  await state.remove();
  assert.throws(() => new WeixinAccountState(''), TypeError);
});
