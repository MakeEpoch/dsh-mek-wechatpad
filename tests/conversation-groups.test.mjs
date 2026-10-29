import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const reactPath = process.env.DSH_TEST_REACT,
  jsdomPath = process.env.DSH_TEST_JSDOM;
if (!reactPath || !jsdomPath) {
  console.log('skipped: React/jsdom required for sidebar rendering');
  process.exit(0);
}
const require = createRequire(`${reactPath}/`);
const React = require(reactPath);
const { act } = React;
const { JSDOM } = createRequire(`${jsdomPath}/`)(jsdomPath);
const dom = new JSDOM(
  '<html><head></head><body><div id="root"></div></body></html>',
  { url: 'http://localhost/' },
);
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = require('react-dom/client');
let plugin;
let failRename = false;
let settingsRevision = 1;
const savedSettings = {
  mergeReplies: false, showProgress: true, maxReplyChunkLength: 1800,
  messageMergeDelaySeconds: 0, incomingMessageMode: 'queue', cwd: '', chatOverrides: [],
};
window.__ModuleLoader__ = {
  load: ({ factory }) => {
    plugin = factory((specifier) => {
      if (specifier !== '@deepseek-ai/dsh-client-ui-primitives')
        return require(specifier);
      return {
        IconEllipsisOutlineRegular: () =>
          React.createElement('span', null, '…'),
        IconEditOutlineRegular: () => null,
        Menu: ({
          open,
          onClose,
          items,
          onSelect,
          anchor,
          portal,
          closeOnPointerLeave,
        }) => {
          assert.equal(portal, true);
          assert.equal(closeOnPointerLeave, true);
          return React.createElement(
            React.Fragment,
            null,
            anchor,
            open &&
              React.createElement(
                'div',
                {
                  role: 'menu',
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') onClose();
                  },
                },
                items.map((item) =>
                  React.createElement(
                    'button',
                    {
                      key: item.id,
                      role: 'menuitem',
                      onClick: () => onSelect(item.id),
                    },
                    item.label,
                  ),
                ),
              ),
          );
        },
      };
    });
  },
};
vm.runInThisContext(
  await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'),
);
const h = React.createElement;
const opened = [];
const cleanups = [];
let wrapped;
const byId = {
  a: { id: 'a', title: '二维码内容分析' },
  b: { id: 'b', title: '文件内容核对' },
  c: { id: 'c', title: '普通开发会话' },
};
function Rows({ children, className }) {
  return h('div', { className, role: 'tree' }, children);
}
let hideQr = false;
// Mirrors the dsh 0.3 SessionTree shape: one ungrouped ProjectRowItem whose
// label comes from t("group.ungrouped"), then session rows below it.
function NativeTree({
  list,
  groupExpansion,
  setGroupExpanded,
  open,
  t = (key) => key,
}) {
  const [ticks] = React.useState(0);
  void ticks;
  const group = {
    key: '',
    expanded: groupExpansion[''],
    sessionCount: list.ids.length,
  };
  return h(
    'div',
    { className: 'native-tree' },
    h(
      Rows,
      {
        rowKeys:
          hideQr && list.ids.every((id) => id === 'b')
            ? ['empty']
            : ['', ...list.ids],
        className: 'native-rows',
      },
      h(
        'button',
        {
          className: 'native-group-row',
          group,
          onToggle: () => setGroupExpanded('', !group.expanded),
          'aria-expanded': group.expanded,
          onClick: () => setGroupExpanded('', !group.expanded),
        },
        h('span', { className: 'native-folder' }, '📁'),
        h('span', { className: 'native-label' }, t('group.ungrouped')),
      ),
      group.expanded
        ? list.ids.map((id) =>
            h(
              'button',
              { key: id, 'data-session': id, onClick: () => open(id) },
              byId[id].title,
            ),
          )
        : null,
    ),
  );
}
function Browser({ renderSlot }) {
  return h(
    'section',
    null,
    h('div', null, '原生搜索和视图选项'),
    renderSlot?.('native.action', {}, {}),
    h(NativeTree, {
      list: { ids: ['a', 'b', 'c'], byId },
      workspaces: [],
      ungroupedSessionIds: ['a', 'b', 'c'],
      groupExpansion: { '': true },
      setGroupExpanded: () => {},
      open: (id) => opened.push(id),
      t: (key) => key,
    }),
  );
}
const base = {
  component: Browser,
  priority: 0,
  registrant: 'native',
  children: { 'native.action': { kind: 'list' } },
  store: {},
  inject: () => ({}),
  locale: 'workspace',
};
const rows = [
  {
    sessionId: 'a',
    provider: 'pad',
    chatId: 'user_example',
    groupKey: 'pad-alice',
    label: '微信 · user_example',
  },
  {
    sessionId: 'b',
    provider: 'weixin',
    chatId: 'qr-user',
    groupKey: 'qr-peer',
    label: '微信机器人 · 扫码用户',
  },
];
const subscriptions = [];
const registrations = new Map();
const nativeAction = {
  id: Symbol('action'),
  component: () => h('button', null, '原生会话菜单'),
  inject: () => ({}),
};
let disposed = false;
const ctx = {
  effect(fn) {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  },
  slots: {
    entries: (key) => {
      assert.equal(disposed, false, 'disposed context must not be queried');
      return key === 'sidebar.workspaces'
        ? [base]
        : key === 'native.action'
          ? [nativeAction]
          : [];
    },
    subscribe: (_key, fn) => {
      subscriptions.push(fn);
      return () => {};
    },
    inject: () => () => {},
    register: (options, component) => {
      if (options.name.startsWith('wechatpad.peer-browser.')) {
        assert.equal(
          typeof options.id,
          'string',
          'mirrored list entries need a public id',
        );
        registrations.set(options.name, component);
      }
      if (options.name === 'sidebar.workspaces') {
        wrapped = component;
        assert.equal(options.store, base.store);
        assert.equal(options.inject, base.inject);
      }
      return () => {};
    },
  },
  locale: {
    register: () => () => {},
    bind: () => ({ t: (key) => key }),
    getLocale: () => ({ active: 'zh' }),
  },
  connection: {
    rpc: {
      call: async (_channel, _endpoint, { method, payload }) => {
        if (method === 'settings.get') return { ok: true, value: { settings: { ...savedSettings }, revision: settingsRevision } };
        if (method === 'settings.update') {
          assert.equal(payload.expectedRevision, settingsRevision);
          Object.assign(savedSettings, payload.patch);
          settingsRevision += 1;
          return { ok: true, value: { saved: true } };
        }
        if (method === 'conversations.renameGroup') {
          if (failRename)
            return { ok: false, error: { message: '磁盘不可写' } };
          for (const row of rows)
            if (row.groupKey === payload.groupKey) row.label = payload.name;
        }
        return { ok: true, value: { items: rows.map((row) => ({ ...row })) } };
      },
    },
  },
};
plugin.apply(ctx);
assert.ok(wrapped, 'native sidebar adapted through the slot');
const root = createRoot(document.getElementById('root'));
await act(async () => {
  root.render(
    h(wrapped, {
      renderSlot: (key) => {
        assert.equal(key, 'wechatpad.peer-browser.native.action');
        return h(registrations.get(key));
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
});
assert.match(document.body.textContent, /微信 · user_example/);
assert.match(document.body.textContent, /微信机器人 · 扫码用户/);
assert.match(document.body.textContent, /普通开发会话/);
assert.match(document.body.textContent, /原生搜索和视图选项/);
assert.match(document.body.textContent, /原生会话菜单/);
let headers = [...document.querySelectorAll('.wxp-peer-heading')];
assert.equal(headers.length, 2);
await act(async () => headers[0].querySelector('.native-group-row').click());
assert.equal(
  document.querySelector('[data-session="a"]'),
  null,
  'fold only that peer',
);
assert.ok(document.querySelector('[data-session="b"]'));
await act(async () => headers[0].querySelector('.native-group-row').click());
await act(async () => document.querySelector('[data-session="a"]').click());
assert.deepEqual(opened, ['a'], 'native navigation survives grouping');
assert.equal(document.querySelectorAll('[data-session="a"]').length, 1);
await act(async () => document.querySelector('.wxp-peer-actions').click());
assert.equal(
  document.querySelector('input[aria-label="分组名称"]'),
  null,
  'opening menu does not edit or fold',
);
assert.ok(document.querySelector('[data-session="a"]'));
await act(async () => document.querySelector('[role="menuitem"]').click());
let input = document.querySelector('input[aria-label="分组名称"]');
assert.equal(input.value, '微信 · user_example');
const compositionEnter = new dom.window.KeyboardEvent('keydown', {
  key: 'Enter',
  isComposing: true,
  bubbles: true,
  cancelable: true,
});
await act(async () => input.dispatchEvent(compositionEnter));
assert.equal(
  compositionEnter.defaultPrevented,
  true,
  'IME Enter confirms composition without saving',
);
const setInput = async (value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value',
    ).set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
await setInput('我的微信');
failRename = true;
await act(async () =>
  document
    .querySelector('form.wxp-peer-editor')
    .dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true }),
    ),
);
assert.match(
  document.querySelector('[role="alert"]').textContent,
  /磁盘不可写/,
);
assert.ok(
  document.querySelector('input[aria-label="分组名称"]'),
  'failed save keeps editor open',
);
failRename = false;
await act(async () =>
  document
    .querySelector('form.wxp-peer-editor')
    .dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true }),
    ),
);
assert.match(
  document.querySelector('.native-label').textContent,
  /我的微信/,
);
assert.equal(rows[1].label, '微信机器人 · 扫码用户');
await act(async () =>
  document
    .querySelector('.wxp-peer-heading')
    .dispatchEvent(
      new dom.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      }),
    ),
);
assert.equal(document.querySelector('[role="menuitem"]').textContent, '重命名');
await act(async () => document.querySelector('[role="menuitem"]').click());
await act(async () =>
  document
    .querySelector('input[aria-label="分组名称"]')
    .dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
);
assert.equal(
  document.querySelector('input[aria-label="分组名称"]'),
  null,
  'Escape cancels editing',
);
await act(async () => document.querySelector('.wxp-peer-actions').click());
await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === '设置').click());
assert.ok(document.querySelector('[role="dialog"]'));
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
assert.match(document.querySelector('[role="dialog"]').textContent, /我的微信 · 设置/);
await act(async () => {
  const select = document.querySelector('select[name="chat-mergeReplies"]');
  select.value = 'true';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
});
await act(async () => {
  document.querySelector('.wxp-chat-primary').click();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
assert.deepEqual(savedSettings.chatOverrides, [{ provider: 'pad', chatId: 'user_example', mergeReplies: true }]);
assert.equal(document.querySelector('[role="dialog"]'), null);
await act(async () => document.querySelector('.wxp-peer-actions').click());
await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === '设置').click());
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
await act(async () => document.querySelector('.wxp-chat-actions>button').click());
await act(async () => {
  document.querySelector('.wxp-chat-primary').click();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
assert.deepEqual(savedSettings.chatOverrides, []);
hideQr = true;
await act(async () => root.render(h(wrapped)));
assert.equal(
  document.querySelectorAll('.wxp-peer-heading').length,
  1,
  'fully filtered peer leaves no empty group',
);
assert.doesNotMatch(document.body.textContent, /暂无会话/);
await act(async () => root.unmount());
for (const cleanup of cleanups.reverse()) cleanup();
disposed = true;
for (const callback of subscriptions) callback(); // Previously queued notifications after teardown.
dom.window.close();
console.log(
  'sidebar peer grouping: render, native callbacks, fold, no duplication, teardown passed',
);
