import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const keyOf = (provider, chatId) => JSON.stringify([provider, chatId]);
const sameTarget = (a, b) => a?.kind === b?.kind && a?.id === b?.id;

/** Transport-neutral bindings; the Bot plugin validates identities on every use. */
export class BotLinks {
  #ctx; #directory; #send; #logger; #data = { version: 1, revision: 0, links: [] };
  #ready; #serial = Promise.resolve(); #dispose; #stopped = false; #seen = new Set(); #started = false; #lastError = ''; #loaded = false; #activeBridge = null; #typing;
  constructor({ ctx, directory, send, logger = () => {}, typing }) {
    this.#typing = typing;
    this.#ctx = ctx; this.#directory = directory; this.#send = send; this.#logger = logger;
    this.#ready = readFile(join(directory, 'bot-links.json'), 'utf8').then(raw => {
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.links) || !Number.isSafeInteger(data.revision)) throw new Error('Bot 关联记录格式不受支持，请先恢复记录。');
      const keys = data.links.map(row => {
        if (!row || !['pad', 'weixin'].includes(row.provider) || typeof row.chatId !== 'string' || !row.chatId || typeof row.target?.id !== 'string' || !['bot', 'room'].includes(row.target.kind) || Boolean(row.isGroup) !== (row.target.kind === 'room') || Boolean(row.isGroup) !== (row.provider === 'pad' && row.chatId.endsWith('@chatroom'))) throw new Error('Bot 关联记录损坏，请先恢复记录。');
        return keyOf(row.provider, row.chatId);
      });
      if (new Set(keys).size !== keys.length) throw new Error('Bot 关联存在重复记录，请先恢复记录。');
      this.#data = data;
    }).catch(error => { if (error.code !== 'ENOENT') throw error; }).then(() => { this.#loaded = true; });
    // Keep a corrupt store observable without an unhandled rejection at startup.
    void this.#ready.catch(error => logger('error', error.message));
  }
  #bridge() {
    const bridge = this.#activeBridge ?? (this.#ctx.inject ? undefined : this.#ctx.get?.('mekBotBridge'));
    if (bridge?.version !== 1) throw new Error('请先启用支持关联功能的 Bot 插件。');
    return bridge;
  }
  ordinaryDeliveryAllowed(provider, chatId) {
    return this.#loaded && !this.#data.links.some(row => keyOf(row.provider, row.chatId) === keyOf(provider, chatId));
  }
  async view() {
    await this.#ready;
    let targets = [], available = true;
    try { targets = await this.#bridge().targets(); } catch { available = false; }
    return { ...structuredClone(this.#data), available, targets, lastError: this.#lastError };
  }
  async binding(provider, chatId) {
    await this.#ready;
    return structuredClone(this.#data.links.find(row => keyOf(row.provider, row.chatId) === keyOf(provider, chatId)) ?? null);
  }
  async validateTarget(target) { await this.#ready; return this.#bridge().resolve(target); }
  async update({ provider, chatId, isGroup, target, revision }) {
    const work = this.#serial.then(async () => {
      await this.#ready;
      if (revision !== this.#data.revision) throw new Error('关联已在其他窗口更新，请刷新后重试。');
      if (!['pad', 'weixin'].includes(provider) || typeof chatId !== 'string' || !chatId.trim() || chatId !== chatId.trim() || chatId.length > 256) throw new Error('请选择有效的微信聊天。');
      const group = provider === 'pad' && chatId.endsWith('@chatroom');
      if (Boolean(isGroup) !== group) throw new Error('微信聊天类型与聊天 ID 不一致。');
      let resolved;
      if (target !== null) {
        if (!target || target.kind !== (group ? 'room' : 'bot')) throw new Error('微信群只能关联 Bot 群，微信私聊只能关联主 Bot。');
        resolved = await this.#bridge().resolve(target);
      }
      const links = this.#data.links.filter(row => keyOf(row.provider, row.chatId) !== keyOf(provider, chatId));
      if (resolved) links.push({ provider, chatId, isGroup: group, target: { kind: resolved.kind, id: resolved.id } });
      const data = { version: 1, revision: this.#data.revision + 1, links };
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const temp = join(this.#directory, `.bot-links-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      await rename(temp, join(this.#directory, 'bot-links.json'));
      this.#data = data;
      this.#typing?.releasePrefix(`linked:${keyOf(provider, chatId)}`);
      return this.view();
    });
    this.#serial = work.catch(() => {});
    return work;
  }
  async resolve(binding) {
    if (this.#stopped) throw new Error('微信连接已关闭。');
    return this.#bridge().resolve(binding.target);
  }
  async receive(binding, message, prepared) {
    // Removed/demoted/deleted targets fail closed; they never open an ordinary Session.
    const current = await this.binding(binding.provider, binding.chatId);
    if (!sameTarget(current?.target, binding.target)) throw new Error('聊天关联已改变，请重新发送消息。');
    await this.resolve(binding);
    const bridge = this.#bridge();
    if (binding.target.kind === 'bot' && prepared.mode === 'interrupt' && bridge.supportsInterrupt !== true) throw new Error('当前 Bot 插件不支持关联私聊打断，请更新 Bot 插件后重试。');
    const result = await bridge.send(binding.target, {
      text: prepared.text, images: prepared.images,
      mode: binding.target.kind === 'bot' && prepared.mode === 'interrupt' ? 'interrupt' : 'queue',
      requestId: `wechatpad:${binding.provider}:${message.messageId || randomUUID()}`.slice(0, 128),
    });
    const latest = await this.binding(binding.provider, binding.chatId);
    if (sameTarget(latest?.target, binding.target) && typeof bridge.activity === 'function') this.#typing?.acquire(binding.provider, binding.chatId, `linked:${keyOf(binding.provider, binding.chatId)}`, async () => {
      const current = await this.binding(binding.provider, binding.chatId);
      if (!sameTarget(current?.target, binding.target)) return false;
      return (await this.#bridge().activity(binding.target)).busy;
    });
    return result;
  }
  async stop(binding) { this.#typing?.releasePrefix(`linked:${keyOf(binding.provider, binding.chatId)}`); await this.resolve(binding); return this.#bridge().stop(binding.target); }
  start() {
    if (this.#started) return;
    this.#started = true;
    const connect = sub => {
      const bridge = sub.get?.('mekBotBridge') ?? sub.mekBotBridge;
      if (typeof bridge.activity !== 'function') this.#logger('warn', '当前 Bot 插件未提供关联输入状态，请更新 Bot 插件。');
      this.#activeBridge = bridge;
      const off = bridge.subscribe(event => { void this.#outgoing(event).catch(error => (this.#lastError = error.message, this.#logger('warn', `Bot 回复投递失败：${error.message}`))); });
      sub.effect(() => () => { off(); this.#typing?.releasePrefix('linked:'); if (this.#activeBridge === bridge) this.#activeBridge = null; }, 'wechatpad: Bot message subscription');
    };
    if (this.#ctx.inject) { const fiber = this.#ctx.inject(['mekBotBridge'], connect); this.#dispose = () => fiber.dispose(); }
    else if (this.#ctx.get?.('mekBotBridge')) this.#dispose = this.#ctx.get('mekBotBridge').subscribe(event => { void this.#outgoing(event).catch(error => this.#logger('warn', error.message)); });
  }
  async #outgoing(event) {
    await this.#ready;
    if (this.#stopped || !event.id || !event.text?.trim() || this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    if (this.#seen.size > 2048) this.#seen.delete(this.#seen.values().next().value);
    const bridge = this.#bridge();
    await bridge.resolve(event.target);
    for (const row of [...this.#data.links]) {
      if (!sameTarget(row.target, event.target)) continue;
      // Recheck bindings after asynchronous resolution; unlinking stops delivery.
      if (!sameTarget((await this.binding(row.provider, row.chatId))?.target, event.target) || this.#stopped) continue;
      try {
        const result = await this.#send(row.provider, row.chatId, event.text);
        if (result?.ok === false) throw new Error(result.error || '微信发送失败');
      } catch (error) { this.#lastError = error.message; this.#logger('warn', `Bot 回复投递失败：${error.message}`); }
    }
  }
  async dispose() { this.#stopped = true; this.#typing?.releasePrefix('linked:'); await this.#serial; await this.#dispose?.(); }
}
