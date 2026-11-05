import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Discovery only: no message content or protocol authentication/context tokens.
export class ChatDirectory {
  #directory; #rows = new Map(); #ready; #writes = Promise.resolve();
  constructor(directory) {
    this.#directory = directory;
    this.#ready = readFile(join(directory, 'known-chats.json'), 'utf8').then(raw => {
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('微信聊天目录格式无效。');
      for (const row of data.items.slice(-1000)) if (['pad', 'weixin'].includes(row?.provider) && typeof row.chatId === 'string' && row.chatId && typeof row.label === 'string') this.#rows.set(JSON.stringify([row.provider, row.chatId]), { provider: row.provider, chatId: row.chatId, label: row.label.slice(0, 120) });
    }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    void this.#ready.catch(() => {});
  }
  note(provider, message) {
    const pending = this.#writes.then(async () => {
      await this.#ready;
      const chatId = message.chatId;
      if (!['pad', 'weixin'].includes(provider) || typeof chatId !== 'string' || !chatId.trim() || chatId.length > 256) return;
      const key = JSON.stringify([provider, chatId]);
      const name = message.isGroup ? message.groupName : message.senderName;
      const label = (typeof name === 'string' && name.trim() ? name.trim() : this.#rows.get(key)?.label || chatId).slice(0, 120);
      if (this.#rows.get(key)?.label === label) return;
      const next = new Map(this.#rows);
      next.delete(key);next.set(key, { provider, chatId, label });
      while (next.size > 1000) next.delete(next.keys().next().value);
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const temp = join(this.#directory, `.known-chats-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ version: 1, items: [...next.values()] }), { mode: 0o600 });
      await rename(temp, join(this.#directory, 'known-chats.json'));
      this.#rows = next;
    });
    this.#writes = pending.catch(() => {});
    return pending;
  }
  async list() { await this.#ready; await this.#writes; return [...this.#rows.values()].map(row => ({ ...row })); }
  flush() { return this.#writes; }
}
