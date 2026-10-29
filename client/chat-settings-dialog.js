import React from 'react';
import { createPortal } from 'react-dom';

const h = React.createElement;
const FIELDS = ['cwd', 'mergeReplies', 'showProgress', 'maxReplyChunkLength', 'messageMergeDelaySeconds', 'incomingMessageMode'];

export const CHAT_SETTINGS_CSS = `
.wxp-chat-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px}
.wxp-chat-dialog{width:min(620px,100%);max-height:min(84vh,720px);overflow:auto;background:var(--dsw-alias-bg-l1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:14px;padding:20px;box-shadow:0 18px 48px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:14px;font:inherit}
.wxp-chat-dialog *{box-sizing:border-box}.wxp-chat-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.wxp-chat-head h2{font-size:17px;line-height:24px;margin:0}.wxp-chat-subtitle{font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin:3px 0 0}.wxp-chat-dialog button{font:inherit;cursor:pointer;color:inherit;background:var(--dsw-alias-bg-l2,#f8f8f8);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:7px;padding:6px 12px}.wxp-chat-dialog button:disabled{opacity:.55;cursor:default}.wxp-chat-dialog .wxp-chat-close{border:0;background:none;font-size:20px;line-height:24px;padding:0 3px}.wxp-chat-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.wxp-chat-field{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:13px}.wxp-chat-field>span{color:var(--dsw-alias-label-secondary)}.wxp-chat-field small{color:var(--dsw-alias-label-tertiary);font-size:11px}.wxp-chat-field select,.wxp-chat-field input{font:inherit;width:100%;min-width:0;color:inherit;background:var(--dsw-alias-bg-l2,#fafafa);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:7px;padding:7px 9px}.wxp-chat-number{display:flex;gap:7px}.wxp-chat-number select{flex:1}.wxp-chat-number input{width:100px}.wxp-chat-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#ddd);padding-top:14px}.wxp-chat-actions>div{display:flex;gap:8px}.wxp-chat-dialog .wxp-chat-primary{background:var(--dsw-alias-state-business-primary,#4a6cf7);border-color:transparent;color:#fff}.wxp-chat-error{color:var(--dsw-alias-state-error-primary,#c33);font-size:12px}.wxp-chat-dialog :is(button,input,select):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a6cf7);outline-offset:2px}@media(max-width:540px){.wxp-chat-grid{grid-template-columns:1fr}.wxp-chat-dialog{padding:15px}.wxp-chat-backdrop{padding:10px}}
`;

function selectedOverride(settings, peer) {
  return (settings.chatOverrides ?? []).find((row) => row.provider === peer.provider && row.chatId === peer.chatId) ?? null;
}

function cleanDraft(draft) {
  return Object.fromEntries(FIELDS.filter((field) => draft[field] !== undefined && draft[field] !== 'inherit' && draft[field] !== '')
    .map((field) => [field, draft[field]]));
}

export function ChatSettingsDialog({ peer, onClose, readSettings, updateSettings }) {
  const [model, setModel] = React.useState(null);
  const [draft, setDraft] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const dialogRef = React.useRef(null);

  React.useEffect(() => {
    let active = true;
    readSettings().then((next) => {
      if (!active) return;
      setModel(next);
      setDraft(cleanDraft(selectedOverride(next.settings ?? {}, peer) ?? {}));
    }).catch((failure) => { if (active) setError(failure.message || String(failure)); });
    dialogRef.current?.focus();
    return () => { active = false; };
  }, [peer.provider, peer.chatId, readSettings]);

  const general = model?.settings ?? {};
  const original = cleanDraft(selectedOverride(general, peer) ?? {});
  const changed = JSON.stringify(cleanDraft(draft)) !== JSON.stringify(original);
  const set = (field, value) => setDraft((previous) => {
    const next = { ...previous };
    if (value === 'inherit' || value === '') delete next[field];
    else next[field] = value;
    return next;
  });
  const value = (field) => draft[field] ?? 'inherit';
  const select = (field, label, choices, generalLabel) => h('label', { className: 'wxp-chat-field' },
    h('span', null, label),
    h('select', { name: `chat-${field}`, value: String(value(field)), onChange: (event) => {
      const chosen = event.target.value;
      set(field, chosen === 'true' ? true : chosen === 'false' ? false : chosen);
    } },
      h('option', { value: 'inherit' }, `跟随通用设置（${generalLabel}）`),
      ...choices.map(([key, title]) => h('option', { value: key, key }, title))));
  const number = (field, label, min, max, step) => h('label', { className: 'wxp-chat-field' },
    h('span', null, label),
    h('div', { className: 'wxp-chat-number' },
      h('select', { name: `chat-${field}-mode`, value: value(field) === 'inherit' ? 'inherit' : 'custom',
        onChange: (event) => set(field, event.target.value === 'inherit' ? 'inherit' : general[field]) },
        h('option', { value: 'inherit' }, `跟随通用设置（${general[field] ?? ''}）`),
        h('option', { value: 'custom' }, '单独设置')),
      value(field) !== 'inherit' ? h('input', { type: 'number', name: `chat-${field}`, min, max, step,
        value: value(field), onChange: (event) => set(field, event.target.value === '' ? 'inherit' : Number(event.target.value)) }) : null));

  const save = async () => {
    if (!model || busy || !changed) return;
    setBusy(true); setError('');
    try {
      const rows = (general.chatOverrides ?? []).filter((row) => row.provider !== peer.provider || row.chatId !== peer.chatId);
      const override = cleanDraft(draft);
      if (Object.keys(override).length) rows.push({ provider: peer.provider, chatId: peer.chatId, ...override });
      await updateSettings({ chatOverrides: rows }, model.revision);
      // Settings updates can remount the plugin. Confirm the saved row before
      // closing so the menu never claims an unpersisted edit succeeded.
      let confirmed = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt ? 650 : 250));
        try {
          const next = await readSettings();
          if (JSON.stringify(cleanDraft(selectedOverride(next.settings ?? {}, peer) ?? {})) === JSON.stringify(override)) {
            confirmed = true;
            break;
          }
        } catch { /* a settings update may briefly remount the plugin */ }
      }
      if (!confirmed) throw new Error('保存后未能确认设置，请重新打开核对。');
      onClose();
    } catch (failure) {
      setError(failure.message || String(failure));
      try { setModel(await readSettings()); } catch { /* keep the draft for retry */ }
    } finally { setBusy(false); }
  };

  return createPortal(h('div', { className: 'wxp-chat-backdrop', onMouseDown: (event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  } }, h('div', { className: 'wxp-chat-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${peer.label} 设置`,
    ref: dialogRef, tabIndex: -1, onKeyDown: (event) => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
    } },
    h('div', { className: 'wxp-chat-head' },
      h('div', null, h('h2', null, `${peer.label} · 设置`),
        h('p', { className: 'wxp-chat-subtitle' }, `${peer.provider === 'weixin' ? '扫码机器人' : 'Pad / Bridge'} · ${peer.chatId}`)),
      h('button', { type: 'button', className: 'wxp-chat-close', 'aria-label': '关闭聊天设置', disabled: busy, onClick: onClose }, '×')),
    !model ? h('p', null, error || '正在读取设置…') : h(React.Fragment, null,
      h('div', { className: 'wxp-chat-grid' },
        select('mergeReplies', '合并一轮回复', [['true', '合并后发送'], ['false', '分段即时发送']], general.mergeReplies ? '合并' : '即时发送'),
        select('showProgress', '运行进度', [['true', '发送'], ['false', '不发送']], general.showProgress ? '发送' : '不发送'),
        number('maxReplyChunkLength', '回复分段长度', 100, 4000, 1),
        number('messageMergeDelaySeconds', '入站合并等待（秒）', 0, 30, 0.5),
        select('incomingMessageMode', '新消息处理方式', [['queue', '排队'], ['interrupt', '打断']], general.incomingMessageMode === 'interrupt' ? '打断' : '排队'),
        h('label', { className: 'wxp-chat-field' }, h('span', null, '新会话工作目录'),
          h('input', { type: 'text', name: 'chat-cwd', value: value('cwd') === 'inherit' ? '' : value('cwd'),
            placeholder: '留空跟随通用设置', onChange: (event) => set('cwd', event.target.value.trim()) }),
          h('small', null, general.cwd ? `通用目录：${general.cwd}` : '通用目录留空时，按聊天自动创建目录'))),
      error ? h('p', { className: 'wxp-chat-error', role: 'alert' }, error) : null,
      h('div', { className: 'wxp-chat-actions' },
        h('button', { type: 'button', disabled: busy || !Object.keys(cleanDraft(draft)).length,
          onClick: () => setDraft({}) }, '全部跟随通用设置'),
        h('div', null,
          h('button', { type: 'button', disabled: busy, onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'wxp-chat-primary', disabled: busy || !changed,
            onClick: () => void save() }, busy ? '保存中…' : '保存设置'))))
  )), document.body);
}
