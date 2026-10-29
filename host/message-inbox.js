/** Debounce ordinary messages by chat/sender and serialize admission per chat. */
export class MessageInbox {
  #dispatch;
  #onError;
  #batches = new Map();
  #chains = new Map();
  #versions = new Map();
  #disposed = false;

  constructor({ dispatch, onError }) {
    this.#dispatch = dispatch;
    this.#onError = onError;
  }

  add(message, delayMs) {
    if (this.#disposed) return;
    const key = JSON.stringify([message.chatId, message.senderId]);
    let batch = this.#batches.get(key);
    if (!batch && delayMs <= 0) return this.#submit(message);
    if (!batch) {
      batch = { key, messages: [], size: 0, timer: null };
      this.#batches.set(key, batch);
    }
    batch.messages.push(message);
    batch.size += message.text.length;
    clearTimeout(batch.timer);
    // A continuously typing chat must not grow one unbounded batch.
    if (delayMs <= 0 || batch.messages.length >= 50 || batch.size >= 16_000) return this.#flush(batch);
    batch.timer = setTimeout(() => this.#flush(batch), delayMs);
    batch.timer.unref?.();
  }

  #flush(batch) {
    clearTimeout(batch.timer);
    this.#batches.delete(batch.key);
    const first = batch.messages[0];
    return this.#submit({ ...first, text: batch.messages.map((message) => message.text).join('\n'), attachments: batch.messages.flatMap((message) => message.attachments ?? []), groupContextCursor: batch.messages.at(-1)?.groupContextCursor });
  }

  #submit(message) {
    const chatId = message.chatId;
    const version = this.#versions.get(chatId) ?? 0;
    const isCurrent = () => !this.#disposed && (this.#versions.get(chatId) ?? 0) === version;
    const previous = this.#chains.get(chatId) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (isCurrent()) await this.#dispatch(message, isCurrent);
    }).catch(async (error) => {
      if (isCurrent()) await this.#onError(message, error);
    }).catch(() => {});
    this.#chains.set(chatId, task);
    void task.then(() => { if (this.#chains.get(chatId) === task) this.#chains.delete(chatId); });
    return task;
  }

  cancelChat(chatId) {
    this.#versions.set(chatId, (this.#versions.get(chatId) ?? 0) + 1);
    for (const batch of this.#batches.values()) {
      if (batch.messages[0].chatId !== chatId) continue;
      clearTimeout(batch.timer);
      this.#batches.delete(batch.key);
    }
  }

  dispose() {
    this.#disposed = true;
    for (const batch of this.#batches.values()) clearTimeout(batch.timer);
    this.#batches.clear();
  }
}
