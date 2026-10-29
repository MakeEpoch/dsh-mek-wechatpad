/**
 * Renders the settings section against a fake dsh Host.
 *
 * The bundle is loaded exactly the way the Web shell loads it — through
 * `window.__ModuleLoader__.load({ id, factory })` with `react` resolved from
 * the host registry — so this covers the loader contract, the slot
 * registration, the RPC transport, the status/read/update cycle, and the
 * secret never coming back across the wire.
 *
 * It needs React and jsdom, which the repository does not vendor; point the
 * two env vars at an installed copy to run it:
 *
 *   DSH_TEST_REACT=/path/to/node_modules/react \
 *   DSH_TEST_JSDOM=/path/to/node_modules/jsdom \
 *   node tests/settings-page.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const reactPath = process.env.DSH_TEST_REACT;
const jsdomPath = process.env.DSH_TEST_JSDOM;
if (!reactPath || !jsdomPath) {
  console.log('skipped: set DSH_TEST_REACT and DSH_TEST_JSDOM to render the settings page');
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const calls = [];
let describeBroken = false;
const saved = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8059',
  key: undefined,
  keyConfigured: false,
  apiPrefix: '',
  wxid: '',
  receiveMode: 'websocket',
  requestTimeoutSeconds: 20,
  cwd: '',
  agentPreset: '',
  sessionTitlePrefix: '微信',
  replyStyle: 'text',
  maxReplyChunkLength: 1800,
  showProgress: true,
  dmPolicy: 'allowlist',
  groupPolicy: 'disabled',
  allowedUsers: ['wxid_a'],
  allowedGroups: [],
  groupRequireMention: true,
  selfWxid: '',
  commandPrefix: '/',
};

function reply(value) {
  return { result: { ok: true, value } };
}

const connection = {
  rpc: {
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload });
      assert.equal(channel, '/api', 'the panel must use the shared /api carrier');
      assert.equal(endpoint, 'dsh-wechatpad', 'endpoint must not carry a leading slash');
      const { method } = payload;
      if (method === 'settings.get') {
        if (describeBroken) {
          return reply({ settings: saved, defaults: {}, entryId: 'wechatpad', revision: undefined, readable: false, reason: 'entry-not-projected' });
        }
        return reply({ settings: saved, defaults: {}, entryId: 'wechatpad', revision: 3, readable: true });
      }
      if (method === 'status.get') {
        return reply({ phase: 'connected', label: '已连接', since: Date.now(), lastError: '', receiveMode: 'websocket', baseUrl: saved.baseUrl, messagesIn: 2, messagesOut: 1, webhookUrl: '', connected: true, keyConfigured: saved.keyConfigured });
      }
      if (method === 'groups.seen') {
        return reply({ items: [{ chatId: 'room_sample@chatroom', count: 3, lastAt: Date.now(), sample: '在吗' }] });
      }
      if (method === 'connection.test') return reply({ ok: true, detail: 'WechatPad 可访问' });
      if (method === 'settings.update') {
        Object.assign(saved, payload.payload.patch);
        saved.key = undefined;
        if (payload.payload.patch.key) saved.keyConfigured = true;
        return reply({ saved: true });
      }
      if (method === 'settings.reset') return reply({ saved: true });
      throw new Error(`unexpected method ${method}`);
    },
  },
};

const registrations = [];
let loaderCall = null;

function makeContext() {
  return {
    effect: (fn, label) => { const dispose = fn(); return dispose ?? (() => {}); },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      getLocale: () => ({ active: 'zh' }),
    },
    slots: {
      inject: (_seat, fn) => fn(),
      register: (options, Component) => {
        registrations.push({ options, Component });
        return () => registrations.splice(registrations.indexOf(registrations[0]), 1);
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
      // dsh's registry provides react-dom too; the settings dialog portals through it.
      if (specifier === 'react-dom') return requireReact('react-dom');
      throw new Error(`unexpected external dependency: ${specifier}`);
    };
    dom.window.pluginExports = factory(requireFn);
  },
};

new Function('window', 'document', bundle)(dom.window, dom.window.document);

assert.equal(loaderCall.id, '@dsh/wechatpad');
assert.ok(dom.window.pluginExports.apply, 'the bundle must export apply');
assert.deepEqual(dom.window.pluginExports.inject, ['slots', 'connection', 'locale']);

const dispose = dom.window.pluginExports.apply(makeContext());
assert.equal(typeof dispose, 'function', 'apply must return its teardown');
assert.equal(registrations.length, 1, 'exactly one settings section registers');
assert.equal(registrations[0].options.name, 'settings.section');
assert.equal(registrations[0].options.id, 'dsh-wechatpad');

const container = dom.window.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
await act(async () => {
  root.render(React.createElement(registrations[0].Component, { close: () => {} }));
});
await act(async () => { await Promise.resolve(); });

const text = () => container.textContent;
assert.match(text(), /微信/);
assert.match(text(), /已连接/);
assert.doesNotMatch(text(), /secret/, 'the key never reaches the browser');
assert.equal(container.querySelectorAll('input[type=password]').length, 1);
assert.equal(container.querySelectorAll('section').length >= 4, true);
// Groups live behind a dialog: the card only summarises, and opening the
// dialog is what reveals ids, last-message time, and the allowlist action.
assert.match(text(), /已发现 1 个群|seenGroupsSummary/);
assert.doesNotMatch(text(), /room_sample@chatroom/);
const openGroups = [...container.querySelectorAll('button')].find((button) => button.textContent === '查看群聊' || button.textContent === 'openGroups');
await act(async () => { openGroups.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
// The dialog is portalled to <body> so the panel's own scroll container cannot
// clamp a position:fixed backdrop to its bounds.
const dialog = dom.window.document.querySelector('[role=dialog]');
assert.ok(dialog, 'the group list renders as a dialog');
assert.equal(dialog.parentElement.className, 'wxp-backdrop');
assert.equal(dialog.parentElement.parentElement, dom.window.document.body);
assert.match(dialog.textContent, /room_sample@chatroom/);
// Columns: id, last-message time, count, action. The harness binds the locale
// without dictionaries, so `createTranslator` falls back to the module's own
// source text rather than rendering raw keys — match that source text.
assert.match(dialog.textContent, /群 ID.*最后消息.*消息数.*操作/);
assert.match(dialog.textContent, /刚刚|分钟前|小时前/);

// A user edits the base URL and saves: the write carries only the changed field
// and no secret. jsdom owns a second realm, so the event must be constructed
// from its window or React's synthetic event system never sees it.
const urlInput = container.querySelector('input[name=baseUrl]');
const setNativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
await act(async () => {
  setNativeValue.call(urlInput, 'http://127.0.0.1:9000');
  urlInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
assert.equal(container.querySelector('input[name=baseUrl]').value, 'http://127.0.0.1:9000', 'the edit must be visible in the controlled input');
const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存并连接' || button.textContent === '保存更改' || button.textContent === 'save');
await act(async () => { saveButton.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });

await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
const update = calls.find((call) => call.payload.method === 'settings.update');
assert.ok(update, 'saving must call settings.update');
assert.equal(update.payload.payload.patch.baseUrl, 'http://127.0.0.1:9000');
assert.equal(update.payload.payload.patch.key, undefined);
assert.equal(update.payload.payload.expectedRevision, 3);

// Connection test round-trips through the same channel.
const testButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '检测连接' || button.textContent === 'test');
await act(async () => { testButton.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
assert.ok(calls.some((call) => call.payload.method === 'connection.test'));
assert.match(text(), /WechatPad 可访问|connection test/);

// A form the Host could not describe must not lock the page: the write reports
// its own failure instead of leaving a dead button.
describeBroken = true;
await act(async () => { root.unmount(); });
const rootBroken = ReactDOMClient.createRoot(container);
await act(async () => { rootBroken.render(React.createElement(registrations[0].Component, { close: () => {} })); });
await act(async () => { await Promise.resolve(); });

await act(async () => {
  const input = container.querySelector('input[name=baseUrl]');
  setNativeValue.call(input, 'http://127.0.0.1:9999');
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
assert.equal([...container.querySelectorAll('.wxp-footer button')].at(-1).disabled, false, 'an undescribed form remains editable and saveable');
describeBroken = false;

await act(async () => { rootBroken.unmount(); });
dispose();
console.log('Settings page checks passed: loader id, slot registration, status render, secret redaction, save and test round trips.');
