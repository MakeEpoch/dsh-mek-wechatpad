import React, { useEffect, useState } from 'react';
const h = React.createElement;
const targetKey = target => JSON.stringify([target.kind, target.id]);

export function BotLinksPanel({ call }) {
  const [view, setView] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState('pad'), [chatId, setChatId] = useState(''), [selected, setSelected] = useState('');
  const group = provider === 'pad' && chatId.trim().endsWith('@chatroom');
  const load = async () => { try { setView(await call('bot-links.get', {})); setError(''); } catch (failure) { setError(failure.message); } };
  useEffect(() => { void load(); }, [call]);
  const update = async payload => {
    if (busy || !view) return;
    setBusy(true); setError('');
    try { setView(await call('bot-links.update', { ...payload, revision: view.revision })); }
    catch (failure) { setError(failure.message); try { setView(await call('bot-links.get', {})); } catch {} }
    finally { setBusy(false); }
  };
  const targets = (view?.targets ?? []).filter(target => target.kind === (group ? 'room' : 'bot'));
  return h('section', { className: 'wxp-card', 'aria-label': 'Bot 关联' },
    h('div', { className: 'wxp-cardHead' }, h('span', { className: 'wxp-cardTitle' }, 'Bot 关联'),
      h('button', { type: 'button', disabled: busy, onClick: () => void load() }, '刷新')),
    h('p', null, '微信群关联 Bot 群，微信私聊仅关联主 Bot。关联后的消息进入原 Bot 对话，成员回复同步回微信；未关联的聊天沿用原会话。'),
    view && !view.available ? h('p', { role: 'status' }, 'Bot 插件未就绪，请先启用兼容版本；已有绑定会保留。') : null,
    h('div', { className: 'wxp-grid' },
      h('label', { className: 'wxp-field' }, h('span', null, '微信连接'),
        h('select', { 'aria-label': '微信连接', value: provider, onChange: event => { setProvider(event.target.value); setSelected(''); } },
          h('option', { value: 'pad' }, 'WechatPad'), h('option', { value: 'weixin' }, '微信机器人'))),
      h('label', { className: 'wxp-field' }, h('span', null, '微信聊天 ID'),
        h('input', { 'aria-label': '微信聊天 ID', value: chatId, placeholder: 'wxid 或 xxx@chatroom', onChange: event => { setChatId(event.target.value); setSelected(''); } })),
      h('label', { className: 'wxp-field' }, h('span', null, group ? '关联 Bot 群' : '关联主 Bot'),
        h('select', { 'aria-label': group ? '关联 Bot 群' : '关联主 Bot', value: selected, disabled: !view?.available, onChange: event => setSelected(event.target.value) },
          h('option', { value: '' }, '请选择'), ...targets.map(target => h('option', { key: targetKey(target), value: targetKey(target) }, target.name))))),
    h('div', { className: 'wxp-actions' }, h('button', {
      type: 'button', 'data-kind': 'primary', disabled: busy || !chatId.trim() || !targets.some(target => targetKey(target) === selected),
      onClick: () => { const [kind, id] = JSON.parse(selected); void update({ provider, chatId: chatId.trim(), isGroup: group, target: { kind, id } }); },
    }, busy ? '保存中…' : '保存关联')),
    h('small', null, '关联独立保存并立即生效；多个微信聊天关联同一目标时共享可见回复，仍遵守微信访问控制和群 @ 规则。授权、密钥和交互卡请在 DSH 中处理。'),
    ...(view?.links ?? []).map(row => {
      const target = view.targets.find(candidate => targetKey(candidate) === targetKey(row.target));
      return h('div', { className: 'wxp-row', key: JSON.stringify([row.provider, row.chatId]) },
        h('span', { className: 'wxp-mono' }, `${row.provider} · ${row.chatId} → ${target?.name ?? '目标已不可用'}`),
        h('button', { type: 'button', disabled: busy, onClick: () => void update({ ...row, target: null }) }, '解除关联'));
    }),
    error || view?.lastError ? h('p', { className: 'wxp-error', role: 'alert' }, error || view.lastError) : null);
}
