// Shared per-chat leases serialize start/refresh/stop across ordinary and Bot routes.
export class TypingSignals {
  #send; #enabled; #logger; #rows = new Map(); #timer; #disposed = false;
  constructor({ send, enabled = () => true, logger = () => {} }) { this.#send = send; this.#enabled = enabled; this.#logger = logger; }
  acquire(provider, chatId, key, active) {
    if (this.#disposed || provider !== 'weixin' || !this.#enabled(provider)) return () => {};
    const id = JSON.stringify([provider, chatId]);
    let row = this.#rows.get(id);
    if (!row) { row = { id, provider, chatId, leases: new Map(), chain: Promise.resolve(), pending: 0, requested: false, lastAt: 0, warnedAt: 0 }; this.#rows.set(id, row); }
    const lease = { active, graceUntil: Date.now() + 4000, checking: false };
    row.leases.set(key, lease);
    this.#signal(row, true);
    if (!this.#timer) { this.#timer = setInterval(() => void this.tick(), 2000); this.#timer.unref?.(); }
    let released = false;
    return () => { if (released) return; released = true; if (row.leases.get(key) === lease) this.#release(row, key); };
  }
  #release(row, key) {
    row.leases.delete(key);
    if (!row.leases.size) this.#signal(row, false);
  }
  #signal(row, on, refresh = false) {
    if (row.requested === on && !refresh) return;
    row.requested = on; row.lastAt = Date.now();
    row.pending++;
    row.chain = row.chain.then(async () => {
      try {
        const ok = await this.#send(row.provider, row.chatId, on);
        if (!ok && Date.now() - row.warnedAt > 60000) { row.warnedAt = Date.now(); this.#logger('warn', '微信机器人输入状态未生效，请检查连接、输入状态开关或平台返回的 typing ticket。'); }
      } catch { this.#logger('warn', '微信机器人输入状态发送失败。'); }
    }).finally(() => {
      row.pending--;
      if (!row.pending && !row.leases.size && !row.requested && this.#rows.get(row.id) === row) this.#rows.delete(row.id);
      if (!this.#rows.size) { clearInterval(this.#timer); this.#timer = undefined; }
    });
  }
  async tick() {
    if (this.#disposed) return;
    for (const row of this.#rows.values()) {
      if (!this.#enabled(row.provider)) { for (const key of [...row.leases.keys()]) this.#release(row, key); continue; }
      for (const [key, lease] of row.leases) {
        if (!lease.active || lease.checking) continue;
        lease.checking = true;
        void Promise.resolve().then(lease.active).then(active => {
          if (row.leases.get(key) === lease && !active && Date.now() >= lease.graceUntil) this.#release(row, key);
        }, () => { if (row.leases.get(key) === lease) this.#release(row, key); }).finally(() => { lease.checking = false; });
      }
      if (row.leases.size && Date.now() - row.lastAt >= 8000) this.#signal(row, true, true);
    }
  }
  releasePrefix(prefix) { for (const row of this.#rows.values()) for (const key of [...row.leases.keys()]) if (key.startsWith(prefix)) this.#release(row, key); }
  async dispose() {
    this.#disposed = true; clearInterval(this.#timer); this.#timer = undefined;
    const rows = [...this.#rows.values()];
    for (const row of rows) { row.leases.clear(); this.#signal(row, false); }
    await Promise.all(rows.map(row => row.chain)); this.#rows.clear();
  }
}
