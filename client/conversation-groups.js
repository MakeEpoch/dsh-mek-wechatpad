/** Sidebar presentation adapter for dsh 0.2.x. Native Session rows stay native. */
import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  Menu,
  IconEllipsisOutlineRegular,
  IconEditOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ChatSettingsDialog, CHAT_SETTINGS_CSS } from './chat-settings-dialog.js';
const h = React.createElement;
const OWNER = '@dsh/wechatpad:conversation-groups';
const CSS = `.wxp-peer-heading{display:flex;align-items:center;gap:2px}.wxp-peer-heading>*:first-child{flex:1;min-width:0;width:auto}.wxp-peer-actions{opacity:0;border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:5px;border-radius:5px}.wxp-peer-heading[data-menu-open=true] .wxp-peer-actions,.wxp-peer-heading:hover .wxp-peer-actions,.wxp-peer-heading:focus-within .wxp-peer-actions{opacity:1}.wxp-peer-actions:hover{background:var(--dsw-alias-interactive-bg-hover)}@media(hover:none){.wxp-peer-actions{opacity:1}}.wxp-peer-editor{padding:4px 0}.wxp-peer-edit-row{display:flex;gap:4px;align-items:center}.wxp-peer-edit-row input{flex:1;min-width:0;border:1px solid var(--dsw-alias-state-business-primary,#4a6cf7);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);padding:6px;font:inherit;font-size:13px}.wxp-peer-edit-row button{border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-secondary);font-size:16px;cursor:pointer;padding:4px}.wxp-peer-edit-row button:disabled{opacity:.4;cursor:default}.wxp-peer-error{display:block;font-size:12px;color:var(--dsw-alias-state-danger-primary,#c33);padding:4px}.wxp-conversation-scroll{flex:1;min-height:0;overflow:auto;scrollbar-width:thin}.wxp-peer-tree{display:contents!important}.wxp-peer-rows{display:block;overflow:visible}.wxp-peer-tree>span{display:none}`;

export function subsetSessions(list, ids) {
  const members = new Set(ids);
  return {
    ...list,
    ids: list.ids.filter((id) => members.has(id)),
    byId: Object.fromEntries(
      Object.entries(list.byId).filter(([id]) => members.has(id)),
    ),
  };
}
export function splitConversations(list, records, ungroupedSessionIds) {
  const byId = new Map(records.map((row) => [row.sessionId, row]));
  const groups = new Map();
  const ordinary = [];
  // The ungrouped bucket is whatever the host's current grouping leaves out of
  // every workspace (ungroupedSessionIds), not the raw session list — keeping
  // workspace members out is what preserves the native grouping.
  const members = Array.isArray(ungroupedSessionIds)
    ? ungroupedSessionIds
    : list.ids;
  const known = new Set(members);
  for (const id of members) {
    const row = byId.get(id);
    if (!row) {
      ordinary.push(id);
      continue;
    }
    const group = groups.get(row.groupKey) ?? { ...row, ids: [] };
    group.ids.push(id);
    groups.set(row.groupKey, group);
  }
  // Peer sections split off the same bucket, so no peer id stays ordinary.
  return { groups: [...groups.values()], ordinary, known };
}
function mapElements(node, transform) {
  if (Array.isArray(node))
    return React.Children.map(node, (child) => mapElements(child, transform));
  if (!React.isValidElement(node)) return node;
  const replaced = transform(node);
  if (replaced !== node) return replaced;
  return node.props.children === undefined
    ? node
    : React.cloneElement(node, {}, mapElements(node.props.children, transform));
}
function PeerHeader({ row, label, chatId, groupKey, onRename, onSettings, provider }) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState(label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const begin = () => {
    setMenuOpen(false);
    setName(label);
    setError('');
    setEditing(true);
  };
  if (editing)
    return h(
      'form',
      {
        className: 'wxp-peer-editor',
        onSubmit: async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            await onRename(groupKey, name);
            setEditing(false);
          } catch (error) {
            setError(error.message || '保存失败，请重试');
          } finally {
            setBusy(false);
          }
        },
        onKeyDown: (event) => {
          if (
            event.key === 'Enter' &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          ) {
            event.preventDefault();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) setEditing(false);
          }
        },
      },
      h(
        'div',
        { className: 'wxp-peer-edit-row' },
        h('input', {
          'aria-label': '分组名称',
          autoFocus: true,
          value: name,
          disabled: busy,
          onFocus: (event) => event.target.select(),
          onChange: (event) => setName(event.target.value),
        }),
        h(
          'button',
          {
            type: 'submit',
            disabled: busy || !name.trim(),
            'aria-label': '保存分组名称',
            title: '保存',
          },
          busy ? '…' : '✓',
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            'aria-label': '取消重命名',
            title: '取消',
            onClick: () => setEditing(false),
          },
          '×',
        ),
      ),
      error
        ? h('span', { role: 'alert', className: 'wxp-peer-error' }, error)
        : null,
    );
  // Reuse the native group row verbatim — folder icon, chevron, spacing and
  // hover all stay native across dsh versions. The label text is relabeled by
  // wrapping `t` in NativeSection; this wrapper only appends peer actions.
  return h(
    'div',
    {
      className: 'wxp-peer-heading',
      'data-menu-open': menuOpen,
      onContextMenu: (event) => {
        event.preventDefault();
        setMenuOpen(true);
      },
    },
    row,
    h(Menu, {
      open: menuOpen,
      onClose: () => setMenuOpen(false),
      items: [
        { id: 'rename', label: '重命名', icon: h(IconEditOutlineRegular) },
        { id: 'settings', label: '设置' },
      ],
      onSelect: (id) => {
        if (id === 'rename') begin();
        if (id === 'settings') { setMenuOpen(false); onSettings({ provider, chatId, label, groupKey }); }
      },
      portal: true,
      closeOnPointerLeave: true,
      anchor: h(
        'button',
        {
          type: 'button',
          className: 'wxp-peer-actions',
          'aria-label': `分组“${label}”的操作`,
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          title: '分组操作',
          onClick: (event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          },
          onKeyDown: (event) => {
            if (
              event.key === 'ArrowDown' ||
              event.key === 'Enter' ||
              event.key === ' '
            ) {
              event.preventDefault();
              setMenuOpen(true);
            }
          },
        },
        h(IconEllipsisOutlineRegular),
      ),
    }),
  );
}
function NativeSection({ NativeTree, treeProps, peer, onRename, onSettings }) {
  const storageKey = peer ? `dsh.wechatpad.group.${peer.groupKey}` : null;
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== 'false';
    } catch {
      return true;
    }
  });
  const onExpanded = (_key, next) => {
    setExpanded(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {}
  };
  const props = peer
    ? {
        ...treeProps,
        groupExpansion: { '': expanded },
        setGroupExpanded: onExpanded,
        // The ungrouped header row reads its label through t("group.ungrouped");
        // wrapping t keeps the native row markup while showing the peer name.
        t: (key, ...rest) =>
          key === 'group.ungrouped' ? peer.label : treeProps.t?.(key, ...rest),
      }
    : treeProps;
  // The captured function is the original slot's native SessionTree. Keeping
  // this call in a stable per-section component retains all its Hooks and rows.
  const tree = NativeTree(props);
  let empty = false;
  mapElements(tree, (element) => {
    if (
      element.props.rowKeys?.length === 1 &&
      element.props.rowKeys[0] === 'empty'
    )
      empty = true;
    return element;
  });
  if (peer && empty) return null; // Native archive filters can hide every row in a known group.
  return mapElements(tree, (element) => {
    if (element === tree)
      return React.cloneElement(
        element,
        { className: 'wxp-peer-tree' },
        mapElements(element.props.children, (child) => {
          if (Array.isArray(child.props.rowKeys))
            return React.cloneElement(
              child,
              { className: 'wxp-peer-rows' },
              mapElements(child.props.children, (row) => {
                if (
                  peer &&
                  row.props.group &&
                  typeof row.props.onToggle === 'function'
                )
                  return h(PeerHeader, {
                    row,
                    label: peer.label,
                    groupKey: peer.groupKey,
                    onRename,
                    onSettings,
                    provider: peer.provider,
                    chatId: peer.chatId,
                    key: row.key,
                  });
                if (peer && row.props.node && row.props.drag)
                  return React.cloneElement(row, { drag: undefined });
                return row;
              }),
            );
          return child;
        }),
      );
    return element;
  });
}
export function PeerGroupedTrees({ NativeTree, treeProps, records, onRename, onSettings }) {
  const { groups, ordinary } = useMemo(
    () =>
      splitConversations(
        treeProps.list,
        records,
        treeProps.ungroupedSessionIds,
      ),
    [treeProps.list, records, treeProps.ungroupedSessionIds],
  );
  if (!groups.length) return h(NativeTree, treeProps);
  const peerIds = new Set(groups.flatMap((peer) => peer.ids));
  const nativeIds = treeProps.list.ids.filter((id) => !peerIds.has(id));
  return h(
    'div',
    { className: 'wxp-conversation-scroll' },
    groups.map((peer) =>
      h(NativeSection, {
        key: peer.groupKey,
        NativeTree,
        peer,
        onRename,
        onSettings,
        treeProps: {
          ...treeProps,
          list: subsetSessions(treeProps.list, peer.ids),
          workspaces: [],
          ungroupedSessionIds: peer.ids,
          // A peer group's local row order must not overwrite the host's global
          // Ungrouped order. Host ordering remains the source on the next render.
          setSessionOrder: () => {},
        },
      }),
    ),
    ordinary.length || treeProps.workspaces.length
      ? h(NativeSection, {
          key: 'ordinary',
          NativeTree,
          treeProps: {
            ...treeProps,
            // Native workspace rows resolve their members through list.byId.
            // Exclude only the peer sections, not every workspace member.
            list: subsetSessions(treeProps.list, nativeIds),
            workspaces: treeProps.workspaces,
            ungroupedSessionIds: ordinary,
          },
        })
      : null,
  );
}
export function wrapConversationBrowser(Browser, readRecords, renameGroup, readSettings, updateSettings) {
  return function ConversationBrowser(props) {
    const [records, setRecords] = useState([]);
    const [settingsPeer, setSettingsPeer] = useState(null);
    const revision = useRef(0);
    const onRename = async (key, name) => {
      ++revision.current;
      const result = await renameGroup(key, name);
      ++revision.current;
      setRecords(result.items ?? []);
    };
    useEffect(() => {
      const controller = new AbortController();
      let running = false;
      const refresh = async () => {
        if (running) return;
        running = true;
        const version = revision.current;
        try {
          const result = await readRecords(controller.signal);
          if (!controller.signal.aborted && version === revision.current)
            setRecords(result.items ?? []);
        } catch {
        } finally {
          running = false;
        }
      };
      void refresh();
      const timer = setInterval(refresh, 10000);
      return () => {
        controller.abort();
        clearInterval(timer);
      };
    }, []);
    const tree = Browser(props);
    const grouped = mapElements(tree, (element) => {
      const p = element.props;
      // Shape guard: a new Host version keeps its original browser if this
      // native tree contract changes. Search results and flat mode stay native.
      if (
        typeof element.type === 'function' &&
        p.list?.byId &&
        Array.isArray(p.workspaces) &&
        Array.isArray(p.ungroupedSessionIds) &&
        p.groupExpansion
      )
        return h(PeerGroupedTrees, {
          NativeTree: element.type,
          treeProps: p,
          records,
          onRename,
          onSettings: setSettingsPeer,
          key: element.key,
        });
      return element;
    });
    return h(React.Fragment, null, grouped,
      settingsPeer ? h(ChatSettingsDialog, { peer: settingsPeer, onClose: () => setSettingsPeer(null), readSettings, updateSettings }) : null);
  };
}
let nextMirrorId = 0;
const alias = (key) => `wechatpad.peer-browser.${key}`;
const aliasChildren = (children) =>
  children &&
  Object.fromEntries(
    Object.entries(children).map(([key, spec]) => [alias(key), spec]),
  );
function optionsFrom(entry, name) {
  const result = {
    name,
    registrant: OWNER,
    id: `wechatpad-mirror-${++nextMirrorId}`,
  };
  for (const key of [
    'key',
    'order',
    'priority',
    'label',
    'locale',
    'store',
    'inject',
  ])
    if (entry[key] !== undefined && typeof entry[key] !== 'symbol')
      result[key] = entry[key];
  if (entry.children) result.children = aliasChildren(entry.children);
  return result;
}
function aliasComponent(Component) {
  return function NativeContribution(props) {
    const renderSlot = props.renderSlot;
    return h(Component, {
      ...props,
      ...(renderSlot
        ? {
            renderSlot: (key, owner, options) =>
              renderSlot(alias(key), owner, options),
          }
        : {}),
    });
  };
}
/** Mirror native child contributions into plugin-owned slots. The Host allows
 * only one declaration owner, so the native slot keys must never be redeclared.
 * Mirrors retain each contribution's own actions, hooks, store and lifecycle. */
function mirrorChildren(ctx, children) {
  const cleanup = [];
  for (const key of Object.keys(children ?? {})) {
    const active = new Map();
    let closed = false;
    const refresh = () => {
      if (closed) return;
      const rows = ctx.slots.entries(key);
      for (const [entry, stop] of active)
        if (!rows.includes(entry)) {
          stop();
          active.delete(entry);
        }
      for (const entry of rows)
        if (!active.has(entry)) {
          const stop = ctx.slots.register(
            optionsFrom(entry, alias(key)),
            aliasComponent(entry.component),
          );
          const stopChildren = mirrorChildren(ctx, entry.children);
          active.set(entry, () => {
            stopChildren();
            stop();
          });
        }
    };
    const unsubscribe = ctx.slots.subscribe(key, refresh);
    refresh();
    cleanup.push(() => {
      closed = true;
      unsubscribe();
      for (const stop of [...active.values()].reverse()) stop();
      active.clear();
    });
  }
  return () => {
    for (const stop of cleanup.reverse()) stop();
  };
}
export function installConversationGroups(ctx, readRecords, renameGroup, readSettings, updateSettings) {
  if (
    typeof ctx.slots.entries !== 'function' ||
    typeof ctx.slots.subscribe !== 'function'
  )
    return () => {};
  const style = document.createElement('style');
  style.dataset.wechatpad = 'conversation-groups';
  style.textContent = CSS + CHAT_SETTINGS_CSS;
  document.head.appendChild(style);
  let selected;
  let stopEntry;
  let stopChildren;
  let closed = false;
  const refresh = () => {
    if (closed) return;
    const base = ctx.slots
      .entries('sidebar.workspaces')
      .find(
        (entry) =>
          entry.registrant !== OWNER && typeof entry.component === 'function',
      );
    if (!base || base === selected) return;
    selected = base;
    stopChildren?.();
    stopEntry?.();
    const options = optionsFrom(base, 'sidebar.workspaces');
    options.priority = (Number(base.priority) || 0) - 1;
    const Browser = wrapConversationBrowser(
      base.component,
      readRecords,
      renameGroup,
      readSettings,
      updateSettings,
    );
    stopEntry = ctx.slots.register(options, function GroupedBrowser(props) {
      const renderSlot = props.renderSlot;
      return h(Browser, {
        ...props,
        ...(renderSlot
          ? {
              renderSlot: (key, owner, options) =>
                renderSlot(alias(key), owner, options),
            }
          : {}),
      });
    });
    stopChildren = mirrorChildren(ctx, base.children);
  };
  const unsubscribe = ctx.slots.subscribe('sidebar.workspaces', refresh);
  refresh();
  return () => {
    closed = true;
    unsubscribe();
    stopChildren?.();
    stopEntry?.();
    style.remove();
  };
}
