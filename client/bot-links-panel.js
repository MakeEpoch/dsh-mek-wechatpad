import React, { useEffect, useState } from 'react';
const h = React.createElement;

// Connections stay here; binding changes belong to the target's own settings.
export function BotLinksPanel({ call }) {
  const [view, setView] = useState(null), [error, setError] = useState('');
  const load = async () => { try { setView(await call('bot-links.get', {})); setError(''); } catch (failure) { setError(failure.message); } };
  useEffect(() => { void load(); }, [call]);
  return h('section', { className: 'wxp-card', 'aria-label': '微信关联' },
    h('div', { className: 'wxp-cardHead' }, h('span', { className: 'wxp-cardTitle' }, '微信关联'),
      h('button', { type: 'button', onClick: () => void load() }, '刷新')),
    h('p', null, '请打开主 Bot 或 Bot 群的右侧详情面板，点击设置，在“微信私聊关联”或“微信群关联”中选择微信用户或群。微信机器人用户发来私聊后即可选择，无需查询 ID。'),
    view && !view.available ? h('p', { role: 'status' }, 'Bot 插件未就绪，已有绑定会保留。') : null,
    ...(view?.links ?? []).map(row => {
      const target = view.targets.find(candidate => candidate.kind === row.target.kind && candidate.id === row.target.id);
      return h('div', { className: 'wxp-row', key: JSON.stringify([row.provider, row.chatId]) },
        h('span', { className: 'wxp-mono' }, (row.provider === 'weixin' ? '微信机器人' : 'WechatPad') + ' · ' + row.chatId + ' → ' + (row.target.kind === 'room' ? 'Bot 群' : '主 Bot') + ' · ' + (target?.name ?? '目标已不可用')));
    }),
    error ? h('p', { className: 'wxp-error', role: 'alert' }, error) : null);
}
