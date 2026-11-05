const same = (a, b) => a?.kind === b?.kind && a?.id === b?.id;
const isGroup = chat => chat.provider === 'pad' && chat.chatId.endsWith('@chatroom');

// Public, credential-free contract for a target's own settings panel.
export function linkConnectionState(config, status, provider) {
  if (!config.enabled || !config.enabledProviders.includes(provider)) return 'disabled';
  if (status?.phase === 'unconfigured') return provider === 'weixin' ? 'login-required' : 'unconfigured';
  if (provider === 'pad' && (!config.baseUrl || !config.token || !config.wxid)) return 'unconfigured';
  if (['error', 'failed'].includes(status?.phase)) return 'error';
  if (status?.connected === true) return 'ready';
  if (['connecting', 'starting', 'idle'].includes(status?.phase) || !status) return 'connecting';
  if (['login-required', 'waiting-scan', 'waiting-confirm', 'expired', 'logged-out'].includes(status?.phase)) return 'login-required';
  return 'disconnected';
}

export function createBotLinkSettings({ links, config, statuses, chats, update }) {
  const connections = target => {
    const settings = config(), live = statuses();
    return ['pad', 'weixin'].filter(provider => target.kind !== 'room' || provider === 'pad').map(provider => ({
      provider, state: linkConnectionState(settings, live[provider], provider),
      policy: provider === 'weixin' ? 'open' : target.kind === 'room' ? settings.groupPolicy : settings.dmPolicy,
      requireMention: target.kind === 'room' && settings.groupRequireMention,
    }));
  };
  const view = async target => {
    await links.validateTarget(target);
    const store = await links.view(), items = new Map();
    for (const row of [...await chats(), ...store.links]) {
      if (!['pad', 'weixin'].includes(row.provider) || typeof row.chatId !== 'string' || !row.chatId) continue;
      if (row.provider === 'weixin' && row.chatId.endsWith('@chatroom')) continue;
      if (isGroup(row) !== (target.kind === 'room')) continue;
      const key = JSON.stringify([row.provider, row.chatId]);
      const binding = store.links.find(link => link.provider === row.provider && link.chatId === row.chatId);
      if (!items.has(key)) items.set(key, { provider: row.provider, chatId: row.chatId, label: row.label || row.chatId,
        linkedHere: !!binding && same(binding.target, target), linkedElsewhere: !!binding && !same(binding.target, target) });
    }
    return { status: 'ready', revision: store.revision, connections: connections(target), chats: [...items.values()],
      deliveryFailed: Boolean(store.lastError),
      links: store.links.filter(link => same(link.target, target)).map(({ provider, chatId }) => ({ provider, chatId })) };
  };
  return {
    version: 1, view,
    async update(target, payload) {
      await links.validateTarget(target);
      const { provider, chatId, revision, remove } = payload ?? {};
      if (!['pad', 'weixin'].includes(provider) || typeof chatId !== 'string' || !chatId.trim() || chatId !== chatId.trim()) throw new Error('请选择有效的微信聊天 ID。');
      if (provider === 'weixin' && chatId.endsWith('@chatroom')) throw new Error('微信机器人不支持关联微信群。');
      if (isGroup({ provider, chatId }) !== (target.kind === 'room')) throw new Error('微信群只能关联 Bot 群，私聊只能关联主 Bot。');
      const current = await links.binding(provider, chatId);
      if (current && !same(current.target, target)) throw new Error('此微信聊天已关联其他目标，请先在原目标中解除关联。');
      if (remove && !current) throw new Error('关联已改变，请刷新后重试。');
      if (!remove) {
        const connection = connections(target).find(row => row.provider === provider);
        if (connection?.state !== 'ready') throw new Error('微信连接尚未就绪，请先在微信设置中恢复连接。');
        if (connection.policy === 'disabled') throw new Error('此类微信聊天已被访问控制关闭，请先在微信设置中启用。');
      }
      await update({ provider, chatId, revision, isGroup: target.kind === 'room', target: remove ? null : target });
      return view(target);
    },
  };
}
