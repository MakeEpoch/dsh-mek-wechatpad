/**
 * Renders the settings section and exercises the tabbed layout.
 *
 * The bundle is loaded exactly the way the Web shell loads it — through
 * `window.__ModuleLoader__.load({ id, factory })` with `react` resolved from
 * the host registry — and the section is rendered through the same
 * `settings.section` slot registration the shell uses. Unlike
 * `settings-page.test.mjs`, the locale bind here actually translates (the
 * component keys its strings by the English source text, and the real
 * `ctx.locale.bind` does the same), so assertions can read user-facing copy.
 *
 * It needs React and jsdom, which the repository does not vendor; point the
 * two env vars at an installed copy to run it:
 *
 *   DSH_TEST_REACT=/path/to/node_modules/react \
 *   DSH_TEST_JSDOM=/path/to/node_modules/jsdom \
 *   node tests/settings-tabs.test.mjs
 *
 * Without them the file prints a notice and exits 0, like the other
 * browser-rendered test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const reactPath = process.env.DSH_TEST_REACT;
const jsdomPath = process.env.DSH_TEST_JSDOM;
if (!reactPath || !jsdomPath) {
  console.log('skipped: set DSH_TEST_REACT and DSH_TEST_JSDOM to render the settings tabs');
  process.exit(0);
}

const requireReact = createRequire(reactPath.endsWith('/') ? reactPath : `${reactPath}/`);
const React = requireReact(reactPath);
const jsdomModule = createRequire(`${jsdomPath.endsWith('/') ? jsdomPath : `${jsdomPath}/`}`)(jsdomPath);
const { JSDOM } = jsdomModule.JSDOM ? jsdomModule : jsdomModule.default;
const ReactDOMClient = requireReact('react-dom/client');
const { act } = requireReact('react');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── A fake Host ──────────────────────────────────────────────────────────
const calls = [];
const saved = {
  enabled: true,
  provider: 'pad',
  enabledProviders: ['pad', 'weixin'],
  baseUrl: 'http://127.0.0.1:8059',
  key: undefined,
  keyConfigured: true,
  apiPrefix: '',
  wxid: '',
  receiveMode: 'websocket',
  bridgeBaseUrl: '',
  bridgeTokenConfigured: false,
  bridgeAccounts: '',
  bridgeClientId: 'dsh',
  webhookPath: '/wechatpad/callback',
  requestTimeoutSeconds: 20,
  weixinAccountFile: '',
  weixinTyping: true,
  weixinReplyQuote: true,
  weixinBotType: '3',
  cwd: '',
  agentPreset: '',
  sessionTitlePrefix: '微信',
  maxReplyChunkLength: 1800,
  showProgress: true,
  mergeReplies: false,
  chatOverrides: [],
  messageMergeDelaySeconds: 0,
  incomingMessageMode: 'queue',
  dmPolicy: 'allowlist',
  groupPolicy: 'disabled',
  allowedUsers: ['wxid_a'],
  allowedGroups: [],
  groupRequireMention: true,
  selfWxid: '',
  commandPrefix: '/',
};
// What the Host reports about a bound iLink bot; null means "not bound".
let bot = null;
// What the next weixin.login.poll answers.
let loginState = 'wait';
let loginTicketCount = 0;

function reply(value) {
  return { result: { ok: true, value } };
}

function fail(code, message) {
  return { result: { ok: false, error: { code, message } } };
}

/** The default fake Host; scenarios below swap `activeRpc` to reuse the same ctx. */
let activeRpc = null;
const connection = {
  rpc: {
    call(channel, endpoint, payload) {
      return activeRpc.call(channel, endpoint, payload);
    },
  },
};

/** The good Host; every scenario points `activeRpc` at one of these. */
const goodRpc = {
  async call(channel, endpoint, payload) {
    calls.push({ channel, endpoint, payload });
    assert.equal(channel, '/api', 'the panel must use the shared /api carrier');
    assert.equal(endpoint, 'dsh-wechatpad', 'endpoint must not carry a leading slash');
    const { method } = payload;
    const body = payload.payload ?? {};
    if (method === 'settings.get') {
      return reply({ settings: { ...saved }, defaults: { requestTimeoutSeconds: 20, weixinBotType: '3' }, entryId: 'wechatpad', revision: 7, readable: true });
    }
    if (method === 'status.get') {
      return reply({
        phase: 'connected', label: '已连接', since: Date.now(), lastError: '',
        receiveMode: saved.receiveMode, baseUrl: saved.baseUrl, messagesIn: 2, messagesOut: 1,
        webhookUrl: '', connected: true, keyConfigured: saved.keyConfigured, provider: saved.provider,
        weixinBound: Boolean(bot), weixinBotId: bot?.id ?? '', weixinBoundAt: bot?.at ?? '',
      });
    }
    if (method === 'groups.seen') return reply({ items: [] });
    if (method === 'conversations.list') return reply({ items: [
      { provider: 'weixin', chatId: 'recipient-full-id', label: '我的微信' },
      { provider: 'weixin', chatId: 'recipient-full-id', label: '我的微信' },
    ] });
    if (method === 'connection.reconnect') return goodRpc.call(channel, endpoint, { method: 'status.get' });
    if (method === 'connection.test') return reply({ ok: true, detail: 'WechatPad 可访问' });
    if (method === 'settings.update') {
      // Like the Host: a written patch lands in the profile, and the secret
      // only ever comes back as a presence flag.
      const { key: writtenKey, ...rest } = body.patch ?? {};
      Object.assign(saved, rest);
      if (writtenKey) saved.keyConfigured = true;
      return reply({ saved: true });
    }
    if (method === 'settings.reset') return reply({ saved: true });
    if (method === 'weixin.login.begin') {
      loginTicketCount += 1;
      loginState = 'wait';
      return reply({
        ticket: `ticket-${loginTicketCount}`,
        state: 'wait',
        qrcodeUrl: 'https://login.weixin.qq.com/qrcode/AbCdEf123',
      });
    }
    if (method === 'weixin.login.poll') {
      if (!body.ticket) return fail('wechatpad/bad-request', '缺少 ticket');
      if (loginState === 'confirmed') bot = { id: 'wxid_bot_7f3a91c2', at: Date.now() };
      return reply({ state: loginState, qrcodeUrl: 'https://login.weixin.qq.com/qrcode/AbCdEf123' });
    }
    if (method === 'weixin.login.cancel') return reply({ cancelled: true });
    if (method === 'weixin.account.reset') { bot = null; return reply({ reset: true }); }
    throw new Error(`unexpected method ${method}`);
  },
};
activeRpc = goodRpc;

// ── Load the bundle the way the Web shell does ────────────────────────────
const registrations = [];
let loaderCall = null;

const ZH = {
  title: '微信',
  status: '状态',
  tabPad: 'WechatPad',
  tabWeixin: '微信机器人',
  tabSession: '会话',
  tabAccess: '访问控制',
  providerLabel: '微信接入方式',
  providerPad: 'WechatPad：直连 Pad / WeChat Bridge',
  providerWeixin: '微信机器人：扫码绑定腾讯 iLink，无需 Pad',
  weixinGenerate: '生成二维码',
  weixinCancel: '取消',
  weixinVerifySubmit: '提交配对码',
  weixinVerifyCode: '配对码',
  weixinUnbind: '解除绑定',
  weixinStateWait: '等待扫码',
  weixinStateScaned: '已扫码，请在手机上确认',
  weixinStateNeedVerifycode: '需要在本页输入配对码',
  weixinBound: '已绑定',
  weixinQrUnavailable: '二维码地址未通过校验，请点击下面的链接打开。',
  weixinQrAlt: '微信绑定二维码',
  savedReloading: '已保存，正在按新配置重新加载…',
  providerReloading: '正在按新接入方式重载…',
  save: '保存',
  test: '测试连接',
  baseUrl: 'WechatPad 地址',
};

function makeContext(locale = 'zh') {
  return {
    effect: (fn) => fn() ?? (() => {}),
    locale: {
      register: () => () => {},
      // The real binding translates a key to the active locale's string.
      bind: () => (key) => (locale === 'zh' ? (ZH[key] ?? key) : key),
      getLocale: () => ({ active: locale }),
    },
    slots: {
      inject: (_seat, fn) => fn(),
      register: (options, Component) => {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    connection,
  };
}

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
dom.window.__ModuleLoader__ = {
  load({ id, factory }) {
    loaderCall = { id };
    const requireFn = (specifier) => {
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}; // Sidebar is not mounted in this fixture.
      if (specifier === 'react') return React;
      if (specifier === 'react/jsx-runtime') return requireReact('react/jsx-runtime');
      if (specifier === 'react-dom') return requireReact('react-dom');
      throw new Error(`unexpected external dependency: ${specifier}`);
    };
    dom.window.pluginExports = factory(requireFn);
  },
};

new Function('window', 'document', bundle)(dom.window, dom.window.document);
assert.equal(loaderCall.id, '@dsh/wechatpad');
const dispose = dom.window.pluginExports.apply(makeContext('zh'));
assert.equal(registrations.length, 1, 'exactly one settings section registers');

// ── Render helpers ────────────────────────────────────────────────────────
const container = dom.window.document.getElementById('root');
let root = ReactDOMClient.createRoot(container);

const tick = async (ms = 0) => { await act(async () => { await Promise.resolve(); if (ms) await new Promise((r) => setTimeout(r, ms)); }); };
const text = () => container.textContent;
const byText = (selector, label) => [...container.querySelectorAll(selector)].find((node) => node.textContent === label);
const tabButton = (id) => container.querySelector(`[role=tab][data-tab=${id}]`);
const click = async (node) => {
  assert.ok(node, 'expected a node to click');
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await tick();
};
const typeInto = async (node, value) => {
  assert.ok(node, 'expected an input to type into');
  const proto = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
  await act(async () => { node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
};
const selectOption = async (node, value) => {
  assert.ok(node, 'expected a select');
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(node, value);
  await act(async () => { node.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  await tick();
};
const keydown = async (node, key) => {
  await act(async () => {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true });
    node.dispatchEvent(event);
  });
  await tick();
};
const render = async () => {
  await act(async () => { root.render(React.createElement(registrations[0].Component, { close: () => {} })); });
  await tick();
};

await render();
await tick(10);
assert.equal(container.querySelectorAll('[role=tab]').length, 4);
assert.equal(tabButton('pad').getAttribute('aria-selected'), 'true');
assert.equal(container.querySelectorAll('select[name=provider]').length, 0, 'no mutually exclusive provider selector');
assert.match(text(), /两种连接可同时启用/);
assert.doesNotMatch(text(), /通过 WechatPad、WeChat Bridge/);
const saveButton = () => [...container.querySelectorAll('.wxp-footer button')].at(-1);
assert.equal(saveButton().disabled, true, 'no redundant saves');
await click(tabButton('weixin'));
await click(tabButton('session'));
await click(tabButton('pad'));
assert.equal(saveButton().disabled, true, 'tab navigation never modifies config');
assert.equal(calls.filter((call) => call.payload.method === 'settings.update').length, 0);
await keydown(tabButton('pad'), 'ArrowRight');
assert.equal(tabButton('weixin').getAttribute('aria-selected'), 'true');
await keydown(tabButton('weixin'), 'End');
assert.equal(tabButton('access').getAttribute('aria-selected'), 'true');
await keydown(tabButton('access'), 'Home');
assert.equal(tabButton('pad').getAttribute('aria-selected'), 'true');
// Only mode-specific fields are shown; advanced defaults are collapsed.
await selectOption(container.querySelector('select[name=connectionMode]'), 'bridge');
assert.ok(container.querySelector('input[name=bridgeBaseUrl]'));
assert.equal(container.querySelector('input[name=baseUrl]'), null);
assert.equal(container.querySelector('select[name=receiveMode]'), null);
assert.ok(container.querySelector('input[name=bridgeClientId]').closest('details:not([open])'));
assert.equal(container.querySelector('#wxp-panel-pad button').disabled, true, 'do not test stale saved settings');
await click(byText('button', '放弃更改'));
assert.equal(container.querySelector('input[name=baseUrl]').value, saved.baseUrl);
assert.equal(saveButton().disabled, true);
await typeInto(container.querySelector('input[name=baseUrl]'), 'http://127.0.0.1:9000');
await click(tabButton('session'));
await click(tabButton('pad'));
assert.equal(container.querySelector('input[name=baseUrl]').value, 'http://127.0.0.1:9000');
await click(saveButton());
await tick(450);
const patch = calls.find((call) => call.payload.method === 'settings.update').payload.payload;
assert.deepEqual(patch.patch, { baseUrl: 'http://127.0.0.1:9000' });
assert.equal(patch.expectedRevision, 7);
assert.equal(saveButton().disabled, true, 'successful readback clears draft');
assert.match(text(), /所有更改已保存/);
await click(tabButton('session'));
assert.equal(container.querySelector('select[name=chatOverrideTarget]'), null);
assert.doesNotMatch(text(), /按聊天覆盖/);
await click(tabButton('pad'));
await click(container.querySelector('#wxp-panel-pad button'));
assert.equal(calls.findLast((call) => call.payload.method === 'connection.test').payload.payload.provider, 'pad');
await click(tabButton('weixin'));
await click(container.querySelector('#wxp-panel-weixin button'));
assert.equal(calls.findLast((call) => call.payload.method === 'connection.test').payload.payload.provider, 'weixin');
await click(byText('button', '生成二维码'));
assert.ok(calls.some((call) => call.payload.method === 'weixin.login.begin'));
assert.ok(container.querySelector('img.wxp-qr'));
await tick(1100);
assert.ok(calls.some((call) => call.payload.method === 'weixin.login.poll'));
await click(byText('button', '取消'));
assert.ok(calls.some((call) => call.payload.method === 'weixin.login.cancel'));
// Enabling/disabling one connection retains the other and its fields.
const botToggle = container.querySelector('#wxp-panel-weixin input[type=checkbox]');
await click(botToggle);
await click(saveButton());
await tick(450);
assert.deepEqual(saved.enabledProviders, ['pad']);
assert.equal(saved.provider, 'pad');
assert.equal(saved.baseUrl, 'http://127.0.0.1:9000');
assert.equal(container.querySelector('button[name=weixinLoginBegin]').disabled, true);
await click(tabButton('access'));
assert.equal(container.querySelector('textarea[name=allowedGroups]'), null);
assert.ok(container.querySelector('textarea[name=allowedUsers]'));
await selectOption(container.querySelector('select[name=groupPolicy]'), 'allowlist');
assert.ok(container.querySelector('textarea[name=allowedGroups]'));
await typeInto(container.querySelector('textarea[name=allowedGroups]'), 'g@chatroom');
await click(tabButton('session'));
await click(tabButton('access'));
assert.equal(container.querySelector('textarea[name=allowedGroups]').value, 'g@chatroom');
await click(byText('button', '放弃更改'));
assert.equal(saveButton().disabled, true);
// Invalid QR hosts must not be embedded.
const safeQrUrl = dom.window.pluginExports.safeQrUrl;
assert.ok(safeQrUrl('https://login.weixin.qq.com/qrcode/a'));
for (const value of ['javascript:alert(1)', 'https://weixin.qq.com.evil.io/qr', 'https://notweixin.qq.com/qr', 'http://weixin.qq.com/a']) assert.equal(safeQrUrl(value), null);
// Real Host failures must not be replaced by a misleading missing-ticket error.
await click(tabButton('weixin'));
saved.enabledProviders = ['pad', 'weixin'];
await act(async () => { root.unmount(); });
root = ReactDOMClient.createRoot(container);
const forwardRpc = goodRpc.call.bind(goodRpc);
activeRpc = { call: async (channel, endpoint, payload) => payload.method === 'weixin.login.begin'
  ? reply({ supported: false, error: '微信服务请求超时，请稍后重试' })
  : forwardRpc(channel, endpoint, payload) };
await render();
await click(tabButton('weixin'));
await click(byText('button', '生成二维码'));
assert.match(text(), /微信服务请求超时，请稍后重试/);
assert.doesNotMatch(text(), /ticket|attemptId/);
assert.match(text(), /仅用于 WechatPad \/ Bridge；扫码机器人不使用白名单/);
// A denied sender is visible and can be staged explicitly without opening DMs.
activeRpc = { call: async (channel, endpoint, payload) => payload.method === 'status.get'
  ? reply({ provider: 'pad', connections: { pad: { phase: 'connected', label: '已连接', messagesIgnored: 1, lastIgnored: { reason: 'dm-not-allowed', senderId: 'wxid_new_pad' } } } })
  : forwardRpc(channel, endpoint, payload) };
await act(async () => { root.unmount(); });
root = ReactDOMClient.createRoot(container); await render();
await click(tabButton('pad'));
assert.match(text(), /已收到消息，但发送者不在私聊白名单中/);
assert.match(text(), /wxid_new_pad/);
const oldUsers = [...saved.allowedUsers];
await click(byText('button', '加入私聊白名单'));
assert.deepEqual(saved.allowedUsers, oldUsers, 'allowing a sender first stages a reviewable draft');
assert.equal(saved.dmPolicy, 'allowlist', 'never opens access to all senders');
assert.match(container.querySelector('textarea[name=allowedUsers]').value, /wxid_new_pad/);
await click(byText('button', '放弃更改'));
// Global notification settings select one recipient and persist independent toggles.
await click(tabButton('session'));
assert.match(text(), /全局微信通知/);
assert.match(text(), /权限仍在 DSH 桌面或网页处理/);
const recipients = container.querySelector('select[name=notificationChat]');
assert.equal(recipients.options.length, 2, 'multiple sessions for one chat are deduplicated');
await selectOption(recipients, JSON.stringify(['weixin', 'recipient-full-id']));
assert.equal(container.querySelector('input[name=notificationChatId]').value, 'recipient-full-id');
const notificationToggle = (label) => [...container.querySelectorAll('label')].find((node) => node.textContent === label)?.querySelector('input');
assert.equal(notificationToggle('任务完成通知').checked, false);
assert.equal(notificationToggle('权限请求通知').checked, false);
await click(notificationToggle('任务完成通知'));
await click(notificationToggle('权限请求通知'));
await click(saveButton()); await tick(450);
assert.equal(saved.notificationProvider, 'weixin');
assert.equal(saved.notificationChatId, 'recipient-full-id');
assert.equal(saved.notifyTaskCompleted, true);
assert.equal(saved.notifyPermissionRequest, true);
assert.equal(saveButton().disabled, true);
await act(async () => { root.unmount(); });
dispose();
console.log('Settings checks passed: independent channels, navigation without mutation, conditional fields, discard, save/readback, targeted probes, QR login and shared policy drafts.');
