/** Live delivery ownership. Listening lasts for the connection, ownership for one Turn. */
import { outboundArtifactRegistry } from './vendor/artifact.js';

export class SessionDelivery {
  #catalog;
  #provider;
  #onEvent;
  #onCancel;
  #logger;
  #registry;
  #pending = new Map();
  #states = new Map();
  #all = new Set();
  #seen = new Map();
  #stops = [];
  #disposed = false;
  constructor({
    ctx,
    catalog,
    provider,
    onEvent,
    onCancel,
    logger = () => {},
    registry = outboundArtifactRegistry,
  }) {
    this.#catalog = catalog;
    this.#provider = provider;
    this.#onEvent = onEvent;
    this.#onCancel = onCancel;
    this.#logger = logger;
    this.#registry = registry;
    // Claim ownership before prompt assembly, so scheduled Turns also see the file-return tool.
    this.#stops.push(
      ctx.on(
        'agent/inbox/claimed',
        ({ agent, message, turn }) => {
          const owner = this.#owner(agent?.session?.id);
          if (owner) this.#claim(owner, message, turn);
        },
        { global: true, prepend: true },
      ),
    );
    this.#stops.push(
      ctx.on(
        'session/event',
        (session, event) => this.#observe(session, event),
        { global: true, prepend: true },
      ),
    );
    this.#stops.push(
      ctx.on(
        'session/disposed',
        (session) => {
          for (const state of [...this.#all])
            if (state.owner.sessionId === session?.id) this.#cancel(state);
          this.#states.delete(session?.id);
          this.#seen.delete(session?.id);
        },
        { global: true },
      ),
    );
  }
  trackPrompt(requestId, sessionId, chatId) {
    this.#pending.set(requestId, { sessionId, chatId });
  }
  forgetPrompt(requestId) {
    this.#pending.delete(requestId);
  }
  #owner(id) {
    if (this.#disposed || typeof id !== 'string') return null;
    const owner = this.#catalog.owner(id);
    return owner?.provider === this.#provider ? owner : null;
  }
  #state(owner, turn) {
    if (!Number.isInteger(turn) || turn < 0) return null;
    let state = this.#states.get(owner.sessionId);
    if (state?.turn === turn) return state;
    if (state && !state.ending) this.#cancel(state);
    state = {
      owner,
      turn,
      allowed: false,
      blocked: false,
      ending: false,
      rpcIds: new Set(),
      close: null,
    };
    this.#states.set(owner.sessionId, state);
    this.#all.add(state);
    return state;
  }
  #claim(owner, message, turn) {
    const state = this.#state(owner, turn);
    if (!state || state.blocked || state.ending) return;
    const source = message?.source;
    const pending = this.#pending.get(source?.rpcId);
    const manual =
      source?.kind === 'user' &&
      (state.rpcIds.has(source.rpcId) ||
        (pending?.sessionId === owner.sessionId &&
          pending?.chatId === owner.chatId &&
          owner.current));
    if (source?.kind === 'user' && !manual) {
      // A web prompt in this Turn cannot borrow the WeChat/schedule delivery permission.
      this.#cancel(state);
      return;
    }
    if (!manual && source?.kind !== 'schedule') return;
    if (manual) state.rpcIds.add(source.rpcId);
    if (!state.allowed) {
      state.allowed = true;
      state.close = this.#registry.openTurnConsumer(owner.sessionId, turn);
      this.#onEvent(owner, { type: 'turn/start', data: { turn } }, turn);
      this.#logger(
        'info',
        `微信投递轮次：${this.#provider} · ${owner.chatId} · turn ${turn}（${manual ? '入站' : '定时'}）`,
      );
    }
  }
  #observe(session, event) {
    const owner = this.#owner(session?.id);
    if (!owner || !event) return;
    if (Number.isSafeInteger(event.seq)) {
      if (event.seq <= (this.#seen.get(owner.sessionId) ?? -1)) return;
      this.#seen.set(owner.sessionId, event.seq);
    }
    if (event.type === 'turn/start') {
      this.#state(owner, event.data?.turn);
      return;
    }
    if (event.type === 'user/message') {
      this.#claim(owner, event.data, this.#states.get(owner.sessionId)?.turn);
      return;
    }
    const state = this.#states.get(owner.sessionId);
    if (!state?.allowed || state.blocked || state.ending) return;
    if (Number.isInteger(event.data?.turn) && event.data.turn !== state.turn)
      return;
    if (
      ![
        'assistant/message',
        'tool/call',
        'tool/call-start',
        'turn/error',
        'agent/error',
        'turn/end',
      ].includes(event.type)
    )
      return;
    if (event.type === 'turn/end') state.ending = true;
    try {
      const result = this.#onEvent(owner, event, state.turn);
      if (state.ending)
        void Promise.resolve(result)
          .catch((error) =>
            this.#logger('error', `微信投递失败：${error.message}`),
          )
          .finally(() => this.#release(state));
      else
        result?.catch?.((error) =>
          this.#logger('error', `微信投递失败：${error.message}`),
        );
    } catch (error) {
      this.#logger('error', `处理微信投递事件失败：${error.message}`);
      this.#cancel(state);
    }
  }
  #release(state) {
    state.blocked = true;
    state.allowed = false;
    state.close?.();
    state.close = null;
    for (const id of state.rpcIds) this.#pending.delete(id);
    state.rpcIds.clear();
    this.#all.delete(state);
  }
  #cancel(state) {
    this.#release(state);
    this.#onCancel(state.owner, state.turn);
  }
  cancelChat(chatId) {
    for (const state of [...this.#all])
      if (state.owner.chatId === chatId) this.#cancel(state);
    for (const [id, pending] of this.#pending)
      if (pending.chatId === chatId) this.#pending.delete(id);
  }
  status() {
    return {
      listening: !this.#disposed,
      activeTurns: [...this.#all].filter(
        (state) => state.allowed && !state.blocked,
      ).length,
      pendingPrompts: this.#pending.size,
    };
  }
  dispose() {
    this.#disposed = true;
    for (const stop of this.#stops.splice(0)) stop?.();
    for (const state of [...this.#all]) this.#cancel(state);
    this.#pending.clear();
    this.#states.clear();
    this.#seen.clear();
  }
}
