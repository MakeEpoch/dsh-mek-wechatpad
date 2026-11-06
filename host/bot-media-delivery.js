import { createHash } from 'node:crypto';
import { SessionDelivery } from './session-delivery.js';
import { extractAssistantText } from './harness.js';
import { extractReplyMedia } from './reply-media.js';
import { outboundArtifactRegistry, prepareReplyMedia, materializeOutboundArtifact, releaseOutboundArtifact } from './vendor/artifact.js';

/** One consumer across both connections; only an admitted WeChat request grants file delivery. */
export class BotMediaDelivery {
  #delivery; #turns = new Map(); #send; #valid; #ctx; #logger; #registry;
  constructor({ ctx, send, valid, logger = () => {}, registry = outboundArtifactRegistry }) {
    this.#send = send; this.#valid = valid; this.#ctx = ctx; this.#logger = logger; this.#registry = registry;
    this.#delivery = new SessionDelivery({ ctx, provider: 'linked', catalog: { owner: () => null }, registry,
      allowOwner: valid, logger,
      onEvent: (owner, event, turn) => this.#event(owner, event, turn),
      onCancel: (owner, turn) => this.#cancel(owner.sessionId, turn),
    });
  }
  track(owner, requestId) {
    this.#delivery.trackPrompt(requestId, owner.sessionId, owner.chatId, owner);
    return () => { this.#delivery.forgetPrompt(requestId); this.#delivery.cancelChat(owner.chatId); };
  }
  #key(sessionId, turn) { return JSON.stringify([sessionId, turn]); }
  #cancel(sessionId, turn) {
    const key = this.#key(sessionId, turn), state = this.#turns.get(key);
    state?.controller.abort(); this.#turns.delete(key);
  }
  cancelChat(chatId) { this.#delivery.cancelChat(chatId); }
  dispose() { this.#delivery.dispose(); for (const state of this.#turns.values()) state.controller.abort(); this.#turns.clear(); }
  #event(owner, event, turn) {
    const key = this.#key(owner.sessionId, turn);
    let state = this.#turns.get(key);
    if (!state) { state = { controller: new AbortController(), paths: new Map() }; this.#turns.set(key, state); }
    const signal = state.controller.signal;
    if (event.type === 'assistant/message') {
      const cwd = this.#ctx.get?.('sessions')?.get?.(owner.sessionId)?.header?.cwd;
      for (const path of extractReplyMedia(extractAssistantText(event), cwd).paths) {
        if (state.paths.has(path)) continue;
        if (state.paths.size >= 16) break;
        state.paths.set(path, prepareReplyMedia(path, { cwd, signal }).then(file => ({ file }), error => ({ error })));
      }
    }
    if (event.type !== 'turn/end') return;
    const artifacts = this.#registry.take(owner.sessionId, turn, { signal });
    const finish = async () => {
      const sent = new Set();
      const send = async file => {
        signal.throwIfAborted();
        if (!this.#valid(owner)) return;
        const fingerprint = `${file.fileName}:${createHash('sha256').update(file.bytes).digest('hex')}`;
        if (sent.has(fingerprint)) return;
        await this.#send(owner, file, signal);
        sent.add(fingerprint);
      };
      const report = async error => {
        if (signal.aborted || !this.#valid(owner)) return;
        this.#logger('warn', `Bot 附件投递失败：${error.message}`);
        await this.#send(owner, null, signal, `附件发送失败：${error.message}`);
      };
      try {
        if (['aborted', 'error', 'cancelled'].includes(event.data?.reason?.kind)) return;
        for (const artifact of artifacts) {
          try { await send(await materializeOutboundArtifact(artifact, { signal })); }
          catch (error) { await report(error); }
          finally { releaseOutboundArtifact(artifact); }
        }
        for (const pending of state.paths.values()) {
          try { const result = await pending; if (result.error) throw result.error; await send(result.file); }
          catch (error) { await report(error); }
        }
      } finally {
        for (const artifact of artifacts) releaseOutboundArtifact(artifact);
        this.#cancel(owner.sessionId, turn);
      }
    };
    return finish();
  }
}
