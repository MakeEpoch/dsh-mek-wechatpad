/**
 * The dsh side of the bridge.
 *
 * A plugin cannot reach the Session domain through plain Cordis services: the
 * controller is a Typert Remote Service, and `ctx.typertGateway.invoke/stream`
 * is the in-process transport Remote uses. That transport still requires a
 * `PeerScope`, and the caller's identity is exactly what the prompt records, so
 * every call here speaks for one owner Peer created from `ctx.connection`.
 *
 * No second HTTP server, token or WebSocket is involved: the same Host process
 * answers, the same authorization rules apply, and any Agent/session behaviour
 * (approvals, subagents, tools) is whatever dsh normally does.
 *
 * Two channels are open on top of that transport:
 *  - `session/follow` gives the OPENING SNAPSHOT and then durable frames up to
 *    the current cut, after which the stream ends. It is a catch-up read, not a
 *    live subscription — an answer produced later never arrives on it.
 *  - `ctx.on('session/event', …)` is the live Cordis event the Host emits for
 *    every committed session event. Replies are folded from here, which is the
 *    same seam the shipped IM plugin uses.
 */
import { randomUUID } from 'node:crypto';

/**
 * @typedef {object} SessionSummary
 * @property {string} sessionId
 * @property {string} [title]
 * @property {boolean} [running]
 */

export class HarnessBridge {
  #gateway;
  #peer;
  #logger;
  #timeZone;
  #ctx;
  /** sessionId -> Set<listener> for live session events. */
  #listeners = new Map();
  #live = null;

  /**
   * @param {object} options
   * @param {{ invoke: Function, stream: Function }} options.gateway `ctx.typertGateway`.
   * @param {import('@deepseek-ai/dsh-typert-protocol').PeerScope} options.peer owner-scoped Peer.
   * @param {(level: string, msg: string) => void} [options.logger]
   * @param {string} [options.timeZone] IANA zone recorded on prompts.
   */
  constructor({ gateway, peer, logger = () => {}, timeZone, ctx }) {
    this.#gateway = gateway;
    this.#peer = peer;
    this.#logger = logger;
    this.#timeZone = timeZone;
    this.#ctx = ctx ?? null;
  }

  /**
   * Invoke one Remote method as the owner Peer.
   * @param {string} namespace Remote namespace, e.g. `session`.
   * @param {string} method exported method name, e.g. `prompt`.
   * @param {Record<string, unknown>} args named wire arguments.
   * @param {AbortSignal} [signal]
   */
  async invoke(namespace, method, args, signal) {
    return this.#gateway.invoke({ namespace, method, args, peer: this.#peer, signal });
  }

  /** Open one Remote stream as the owner Peer. */
  async stream(namespace, method, args, signal) {
    return this.#gateway.stream({ namespace, method, args, peer: this.#peer, signal });
  }

  /**
   * Create (or reuse) a Session for a chat.
   * @param {{ cwd?: string, agentPreset?: string, sessionId?: string, workspaceId?: string }} request
   * @returns {Promise<string>} the Session id.
   */
  async createSession({ cwd, agentPreset, sessionId, workspaceId }) {
    const request = {};
    if (workspaceId) request.workspaceId = workspaceId;
    else if (cwd) request.cwd = cwd;
    if (sessionId) request.sessionId = sessionId;
    if (agentPreset) request.agentPreset = agentPreset;
    const created = await this.invoke('session', 'create', { request });
    if (!created || typeof created.sessionId !== 'string') {
      throw new Error('dsh 没有返回会话标识');
    }
    return created.sessionId;
  }

  /**
   * Confirm a stored Session still exists before a chat resumes it. A Session
   * that was deleted in the dsh UI must not silently take a fresh chat id.
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async sessionExists(sessionId) {
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const listed = await this.invoke('session', 'list', { _request: cursor ? { cursor } : {} });
      const items = Array.isArray(listed?.items) ? listed.items : [];
      if (items.some((item) => item?.sessionId === sessionId)) return true;
      cursor = listed?.nextCursor ?? listed?.cursor;
      if (!cursor) return false;
    }
    throw new Error('会话列表分页未读取完，暂不能确认原会话是否存在');
  }

  /** Find the summary row for one Session, when the list exposes it. */
  async sessionSummary(sessionId) {
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const listed = await this.invoke('session', 'list', { _request: cursor ? { cursor } : {} });
      const items = Array.isArray(listed?.items) ? listed.items : [];
      const found = items.find((item) => item?.sessionId === sessionId);
      if (found) return found;
      cursor = listed?.nextCursor ?? listed?.cursor;
      if (!cursor) return null;
    }
    return null;
  }

  /**
   * Admit one prompt as a queued user message.
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.text
   * @param {Array<{type: 'image', mediaType: string, data: string, name?: string}>} [options.images]
   * @returns {Promise<{ accepted: true }>}
   */
  async prompt({ sessionId, text, images = [], requestId = randomUUID() }) {
    const content = [];
    if (text && text.trim()) content.push({ type: 'text', text });
    for (const image of images) content.push({ type: 'image', mediaType: image.mediaType, data: image.data, ...(image.name ? { name: image.name } : {}) });
    if (content.length === 0) throw new Error('消息内容为空');
    const request = {
      requestId,
      sessionId,
      mode: 'queue',
      content,
      ...(this.#timeZone ? { clientTimeZone: this.#timeZone } : {}),
    };
    try { return await this.invoke('session', 'prompt', { request }); }
    catch (error) {
      // These are explicit admission rejections, before a user message exists.
      // Keep original files and the same request id on the text-only fallback.
      if (!images.length || !['session/attachment-invalid', 'attachment-error'].includes(error.code)
        || !['MODEL_DOES_NOT_SUPPORT_IMAGES', 'IMAGE_TOO_LARGE', 'IMAGES_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'TOO_MANY_IMAGES'].includes(error.details?.reason)) throw error;
      return this.invoke('session', 'prompt', { request: { ...request, content: [{ type: 'text', text: `${text || ''}\n\n宿主未接收图片内容块；原图已保存，请根据附件路径使用工具查看，不要假设自己已经看到图片。` }] } });
    }
  }

  /** Cancel one running turn without dropping the pending inbox. */
  async cancel(sessionId) {
    return this.invoke('session', 'cancel', { request: { sessionId } });
  }

  /**
   * Subscribe to newly committed events for one Session. This compatibility
   * helper uses session/event, never the Host's historical session/follow RPC.
   * Stopping releases only this listener; it does not cancel the Session.
   *
   * @param {object} options
   * @param {string} options.sessionId
   * @param {(text: string) => void} [options.onText] every completed answer.
   * @param {(progress: { tool?: string }) => void} [options.onProgress]
   * @param {(error: unknown) => void} [options.onError]
   * @returns {{ stop: () => void, done: Promise<void> }}
   */
  follow({ sessionId, onText = () => {}, onProgress = () => {}, onError = () => {}, onTurnStart = () => {}, onUserMessage = () => {}, onTurnEnd = () => {} }) {
    this.#startLive();
    const listener = { onText, onProgress, onError, onTurnStart, onUserMessage, onTurnEnd };
    const set = this.#listeners.get(sessionId) ?? new Set();
    set.add(listener);
    this.#listeners.set(sessionId, set);

    // A session that already answered while this process was connecting must not
    // replay that history to the chat; the live listener starts from now on.
    // Ordering is guaranteed because the listener above is registered first.
    return {
      stop: () => {
        const current = this.#listeners.get(sessionId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) this.#listeners.delete(sessionId);
      },
      done: Promise.resolve(),
      cursor: undefined,
    };
  }

  /** Subscribe once to the Host's committed session events. */
  #startLive() {
    if (this.#live || !this.#ctx) return;
    // Match dsh-im's global observer while keeping listener ownership on this
    // plugin context, so scoped sessions reach us and teardown stays local.
    const scope = this.#ctx;
    if (typeof scope.on !== 'function') return;
    this.#live = scope.on('session/event', (session, event) => {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || !event || typeof event !== 'object') return;
      const listeners = this.#listeners.get(sessionId);
      if (!listeners) return;
      this.#logger('debug', `session/event ${String(event.type)} id=${sessionId}`);
      for (const listener of [...listeners]) this.#dispatch(listener, event);
    }, { global: true });
  }

  /** Route one committed event to one chat's listener. */
  #dispatch(listener, event) {
    try {
      switch (event.type) {
        case 'turn/start':
          listener.onTurnStart(event.data ?? {});
          return;
        case 'user/message':
          listener.onUserMessage(event.data ?? {}); return;
        case 'turn/end': {
          const task = listener.onTurnEnd(event.data ?? {});
          task?.catch?.((error) => this.#logger('warn', `文件回传失败：${error.message}`));
          return;
        }
        case 'assistant/message': {
          const text = extractAssistantText(event);
          if (text) listener.onText(text);
          return;
        }
        case 'tool/call':
        case 'tool/call-start': {
          const name = event.data?.name ?? event.data?.call?.name ?? event.data?.tool;
          if (typeof name === 'string' && name) listener.onProgress({ tool: name });
          return;
        }
        case 'turn/error':
        case 'agent/error': {
          listener.onError(event.data?.message ? new Error(String(event.data.message)) : new Error('运行出错'));
          return;
        }
        default:
      }
    } catch (error) {
      this.#logger('warn', `处理会话事件失败：${error?.message ?? error}`);
    }
  }

  /** Drop the live subscription (plugin teardown). */
  dispose() {
    if (typeof this.#live === 'function') this.#live();
    this.#live = null;
    this.#listeners.clear();
  }
}

/**
 * Extract user-visible text from one `assistant/message` event. Provider
 * reasoning parts are dropped: they must never be sent to a chat.
 */
export function extractAssistantText(event) {
  const data = event?.data ?? {};
  const message = data.message ?? data;
  const content = message?.content;
  if (typeof message?.text === 'string' && content === undefined) return message.text;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (part.type === 'text' || part.type === 'output_text'))
    .map((part) => String(part.text ?? ''))
    .join('')
    .trim();
}
