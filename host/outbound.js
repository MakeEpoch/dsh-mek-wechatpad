/**
 * Outbound delivery to WeChat.
 *
 * Two WeChat behaviours shape this module:
 *  1. The Pad de-duplicates messages that share one `createTime` second, so
 *     consecutive sends to the same chat are serialized and spaced.
 *  2. A long answer has to become several messages; those must not lose their
 *     order, so everything for one chat goes through a single per-chat queue.
 */
import { SEND_CHUNK_DELAY_MS, sleep } from './pad-api.js';
import { chunkText, stripReasoning } from './inbound.js';

export class OutboundSender {
  #client;
  #logger;
  /** @type {Map<string, Promise<unknown>>} */
  #queues = new Map();
  /** @type {Map<string, number>} */
  #lastSendAt = new Map();

  /**
   * @param {object} options
   * @param {{ sendText: Function, sendImage: Function }} options.client
   * @param {(level: string, msg: string) => void} [options.logger]
   */
  constructor({ client, logger = () => {} }) {
    this.#client = client;
    this.#logger = logger;
  }

  /**
   * Deliver one reply to a chat.
   * @param {string} chatId target chat or contact.
   * @param {string} text markdown-ish answer from the model.
   * @param {{ maxChunkLength?: number, onChunk?: Function }} [options]
   * @returns {Promise<{ ok: boolean, delivered: number, error?: string }>}
   */
  async sendReply(chatId, text, options = {}) {
    const cleaned = stripReasoning(text);
    if (!cleaned) return { ok: false, delivered: 0, error: 'empty reply' };
    const chunks = chunkText(cleaned, options.maxChunkLength ?? 1800);
    let delivered = 0;
    for (const chunk of chunks) {
      const result = await this.#sendOne(chatId, chalk(chunk));
      if (!result.ok) {
        return { ok: false, delivered, error: result.error };
      }
      delivered += 1;
    }
    return { ok: true, delivered };
  }

  /** Send an arbitrary single text message (status lines, command replies). */
  async sendText(chatId, text) {
    return this.#sendOne(chatId, text);
  }

  async #sendOne(chatId, text) {
    return this.sendMedia(chatId, () => this.#client.sendText(chatId, text));
  }

  async sendMedia(chatId, send) {
    return this.#enqueue(chatId, async () => {
      const previous = this.#lastSendAt.get(chatId);
      if (previous !== undefined) {
        const elapsed = Date.now() - previous;
        if (elapsed < SEND_CHUNK_DELAY_MS) await sleep(SEND_CHUNK_DELAY_MS - elapsed);
      }
      const result = await send();
      if (result.ok) this.#lastSendAt.set(chatId, Date.now());
      else this.#logger('warn', `发送到 ${chatId} 失败：${result.error}`);
      return { ok: result.ok, error: result.error, messageId: result.messageId };
    });
  }

  #enqueue(chatId, task) {
    const previous = this.#queues.get(chatId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#queues.set(chatId, next.catch(() => {}));
    return next;
  }
}

/** WeChat renders plain text; drop the markdown scaffolding models like to emit. */
export function chalk(text) {
  return String(text ?? '')
    .replace(/^```[a-zA-Z0-9]*\n/gm, '')
    .replace(/^```$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!`)`([^`\n]+)`(?!`)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
