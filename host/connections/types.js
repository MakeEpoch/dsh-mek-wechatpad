/**
 * The protocol-neutral connection contract.
 *
 * Everything above this file — sessions, prompts, commands, merging, turns,
 * questions, the Settings panel — talks to WeChat through ONE interface, so a
 * second protocol only has to implement this interface instead of reaching into
 * the service. The contract is documented in JSDoc only: the plugin ships plain
 * ESM, so types are documentation, and the runtime guarantee comes from
 * `assertConnection()` plus the contract test.
 *
 * ── WechatConnection ────────────────────────────────────────────────────────
 * @typedef {object} WechatConnection
 * @property {string} id                      stable protocol id: 'pad' | 'weixin'.
 * @property {string} label                   human-readable name for the status bar.
 * @property {(handlers: ConnectionHandlers) => Promise<void>} start
 *   Opens the receive path and starts delivering decoded messages. Resolves
 *   once the first delivery path is up; a failed connect must be reported
 *   through `onState` and/or a rejected promise — the service records both.
 * @property {() => Promise<void> | void} stop
 *   Closes every receive path, pending reconnects and timers. Idempotent.
 * @property {(request: SendRequest) => Promise<SendResult>} send
 *   Delivers ONE already-plain-text message (no markdown cleanup, no chunking:
 *   that stays in the service, which owns reply shaping). Must not throw for a
 *   delivery failure; report it in `{ ok: false, delivered: 0, error }`.
 * @property {(request: {chatId: string, file: {fileName: string, mediaType: string, bytes: Buffer, size: number}, signal?: AbortSignal}) => Promise<SendResult>} [sendFile]
 *   Delivers a materialized attachment to that same chat. Native image/voice
 *   handling belongs to the adapter; unsupported native media goes as a file.
 * @property {(chatId: string, on: boolean) => Promise<boolean>} [typing]
 *   Optional capability: "is typing" indicator. Returns whether it was actually
 *   shown; a protocol without the feature returns false and advertises
 *   `capabilities.typing = false`. Never throws.
 * @property {ConnectionCapabilities} capabilities
 *   What this protocol can express; consumers check it instead of the id.
 * @property {() => ConnectionStatus} [status]
 *   Protocol-specific diagnostics for the panel, including the capabilities it
 *   advertises. Optional; the service tolerates a protocol without it.
 * @property {() => Promise<ProbeResult>} test
 *   Reaches the protocol's endpoint without changing runtime state.
 *
 * ── Optional account lifecycle (qr/binding protocols) ───────────────────────
 * A protocol that binds an account out of band (iLink's QR scan) implements the
 * login sequence; the Pad does not and answers `{ supported: false }` to all
 * four. The Settings page calls these through the service facade.
 * @property {(options?: LoginStartOptions) => Promise<LoginStartResult>} [beginLogin]
 * @property {(attemptId: string) => Promise<LoginPollResult>} [pollLogin]
 * @property {(attemptId: string) => Promise<LoginCancelResult>} [cancelLogin]
 * @property {() => Promise<LifecycleResult>} [resetAccount]
 *
 * @typedef {object} LoginStartOptions
 * @property {AbortSignal} [signal] cancel the pending start.
 *
 * @typedef {object} LoginStartResult
 * @property {boolean} supported        false when the protocol cannot bind.
 * @property {string} [attemptId]       opaque handle for poll/cancel.
 * @property {string} [qrUrl]           scannable QR payload or image URL.
 * @property {string} [detail]          what the user should do next.
 * @property {string} [error]           failure reason.
 *
 * @typedef {object} LoginPollResult
 * @property {boolean} supported
 * @property {'pending' | 'scanned' | 'confirmed' | 'expired' | 'failed'} [state]
 * @property {{ wxid?: string, nickname?: string }} [account] bound account.
 * @property {string} [detail]
 * @property {string} [error]
 *
 * @typedef {object} LoginCancelResult
 * @property {boolean} supported
 * @property {boolean} [cancelled]
 * @property {string} [error]
 *
 * @typedef {object} LifecycleResult
 * @property {boolean} supported
 * @property {boolean} [ok]
 * @property {string} [detail]
 * @property {string} [error]
 *
 * ── Handlers passed to start() ──────────────────────────────────────────────
 * @typedef {object} ConnectionHandlers
 * @property {(message: InboundMessage) => void | Promise<void>} onMessage
 *   Every decoded inbound message, already normalized. May be called for
 *   messages the policy will later drop — the service applies the policy.
 *   Replays after a reconnect are tolerated: the service de-duplicates.
 * @property {(state: ConnectionStateUpdate) => void} onState
 *   Connection phase changes. `phase` uses the service's vocabulary:
 *   'connected' | 'reconnecting' | 'error'. `error` is a human-readable reason
 *   ('' when the phase has none); `label` may override the default wording.
 * @property {(level: 'debug' | 'info' | 'warn' | 'error', message: string) => void} [onLog]
 *   Optional log sink.
 * @property {(event: ConnectionControlEvent) => void} [onControl]
 *   Optional: protocol control traffic the service must acknowledge or surface
 *   (Bridge heartbeats, toggle replies, unsolicited server pushes). `kind` is
 *   'ping' | 'reply' | 'error' | 'warning' | 'info'. A 'ping' expects no reply
 *   from the service; the adapter answers it itself.
 *
 * ── Inbound message (normalized by every adapter) ───────────────────────────
 * @typedef {object} InboundMessage
 * @property {string} messageId   protocol id; '' when the protocol has none.
 * @property {string} chatId      the peer: a wxid for DMs, a `…@chatroom` id for groups.
 * @property {boolean} isGroup
 * @property {string} senderId    the real speaker (in a group, not the group id).
 * @property {string} [senderName] display name when the protocol provides one.
 * @property {string} text        visible text, mention markup removed, media as a placeholder.
 * @property {number} [msgType]   protocol message type; the Pad's numeric codes when known.
 * @property {boolean} mentioned  whether this message addresses the bot.
 * @property {number} createdAt   epoch milliseconds.
 * @property {{ messageId?: string, content?: string, attachments?: unknown[] }} [replyTo]
 * @property {Array<{kind: string, name: string, mediaType?: string, size?: number, transcript?: string, data?: Uint8Array, load?: (options: {signal?: AbortSignal}) => Promise<Uint8Array>}>} [attachments]
 *   Lazy descriptors: the service applies policy before downloading any bytes.
 * @property {unknown} [raw]      the unmodified protocol payload, for debugging only.
 *
 * ── Send ────────────────────────────────────────────────────────────────────
 * @typedef {object} SendRequest
 * @property {string} chatId
 * @property {string} text             plain text, already cleaned and sized by the service.
 * @property {string} [contextToken]   iLink reply/session token; ignored by the Pad.
 * @property {string} [runId]          correlation id for protocols that need one.
 *
 * @typedef {object} SendResult
 * @property {boolean} ok            the whole text reached the protocol.
 * @property {number} delivered      messages actually delivered (0 when ok is false).
 * @property {string} [error]        failure reason when ok is false.
 * @property {string} [messageId]    the protocol's receipt id, when it reports one.
 *
 * ── Capabilities / state / probe ────────────────────────────────────────────
 * @typedef {object} ConnectionCapabilities
 * @property {boolean} typing        "is typing" indicator available.
 * @property {boolean} media         can send images/files.
 * @property {boolean} groupMention  can address one member of a group.
 * @property {boolean} nativeReply   has a first-class reply-to-message concept.
 *
 * @typedef {object} ConnectionStateUpdate
 * @property {'connected' | 'reconnecting' | 'error'} phase
 * @property {string} [label]   override the default phase wording.
 * @property {string} [error]   reason, shown to the operator.
 *
 * @typedef {object} ConnectionControlEvent
 * @property {'ping' | 'reply' | 'error' | 'warning' | 'info'} kind
 * @property {string} [detail]
 *
 * @typedef {object} ConnectionStatus
 * @property {string} provider    alias of `id`.
 * @property {boolean} connected  receive path currently open.
 * @property {string} [lastError] most recent protocol error, '' when none.
 * @property {ConnectionCapabilities} [capabilities] echoed for the panel.
 *
 * @typedef {object} ProbeResult
 * @property {boolean} ok
 * @property {string} detail                    what was checked.
 * @property {string} [error]                   failure reason when ok is false.
 * @property {Record<string, unknown>} [extra]  protocol facts the panel may show.
 */

/** The connection ids this plugin knows about. */
export const CONNECTION_IDS = Object.freeze(['pad', 'weixin']);

/** Default provider when a profile predates the field. */
export const DEFAULT_PROVIDER = 'pad';

/**
 * Capabilities a protocol claims when it does not declare any. Adapters must
 * explicitly advertise media delivery after implementing sendFile.
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  typing: false,
  media: false,
  groupMention: false,
  nativeReply: false,
});

/** Retained in `status().lastError` when the requested adapter cannot load. */
export const UNAVAILABLE_PROVIDER_ERROR = '连接适配器加载失败';

/**
 * Answer shape for a lifecycle hook the protocol does not implement.
 * @param {string} [detail]
 * @returns {{ supported: false, detail: string }}
 */
export function unsupportedFeature(detail = '该连接协议不支持此操作') {
  return { supported: false, detail };
}

/**
 * Fill the capability record, keeping every key boolean and every known key.
 * @param {Partial<ConnectionCapabilities> | undefined} input
 * @returns {ConnectionCapabilities}
 */
export function normalizeCapabilities(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    typing: Boolean(source.typing),
    media: Boolean(source.media),
    groupMention: Boolean(source.groupMention),
    nativeReply: Boolean(source.nativeReply),
  };
}

/**
 * @param {unknown} request
 * @returns {{ chatId: string, text: string, contextToken?: string, runId?: string }}
 */
function normalizeSendRequest(request) {
  const value = /** @type {Record<string, any>} */ (request ?? {});
  return {
    chatId: String(value.chatId ?? ''),
    text: String(value.text ?? ''),
    ...(value.contextToken === undefined ? {} : { contextToken: String(value.contextToken) }),
    ...(value.runId === undefined ? {} : { runId: String(value.runId) }),
  };
}

/**
 * Call one adapter method with normalized arguments, converting a thrown error
 * into the contract's result shapes. Used by every adapter and by the service,
 * so a protocol quirk can never escape as an exception into `apply()`.
 * `send()` never throws; `stop()`/`start()`/`test()` are also total here.
 * @param {WechatConnection} connection
 * @param {SendRequest | unknown} request
 * @returns {Promise<SendResult>}
 */
export async function safeSend(connection, request) {
  const args = normalizeSendRequest(request);
  if (!connection || typeof connection.send !== 'function') {
    return { ok: false, delivered: 0, error: '连接尚未就绪' };
  }
  if (!args.chatId) return { ok: false, delivered: 0, error: '缺少 chatId' };
  if (!args.text) return { ok: false, delivered: 0, error: 'empty reply' };
  try {
    const result = await connection.send(args);
    if (!result || typeof result !== 'object') {
      return { ok: false, delivered: 0, error: '连接未返回发送结果' };
    }
    const ok = Boolean(result.ok);
    return {
      ok,
      delivered: Number.isFinite(Number(result.delivered)) ? Number(result.delivered) : (ok ? 1 : 0),
      ...(result.error === undefined ? {} : { error: String(result.error) }),
      ...(result.messageId === undefined || result.messageId === null ? {} : { messageId: String(result.messageId) }),
    };
  } catch (error) {
    return { ok: false, delivered: 0, error: String(error?.message ?? error) };
  }
}

/**
 * Optional members an adapter MAY expose (documented, never required):
 *   sendFile, typing, status, beginLogin, pollLogin, cancelLogin, resetAccount.
 * Only the required members are enforced, because the Pad adapter is a valid
 * connection without any of them.
 * @type {readonly string[]}
 */
export const OPTIONAL_MEMBERS = Object.freeze([
  'sendFile', 'typing', 'status', 'beginLogin', 'pollLogin', 'cancelLogin', 'resetAccount',
]);

/** Members every adapter MUST expose. */
export const REQUIRED_MEMBERS = Object.freeze([
  'id', 'label', 'start', 'stop', 'send', 'test', 'capabilities',
]);

/**
 * Whether a value looks like a usable connection. Used by tests, by the
 * selector and by the service before it starts one.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isConnection(value) {
  const candidate = /** @type {Record<string, any>} */ (value);
  return Boolean(
    candidate
    && typeof candidate === 'object'
    && typeof candidate.id === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.start === 'function'
    && typeof candidate.stop === 'function'
    && typeof candidate.send === 'function'
    && typeof candidate.test === 'function'
    && candidate.capabilities
    && typeof candidate.capabilities === 'object',
  );
}

/**
 * Throw a descriptive error when a connection breaks the contract. The message
 * names the missing member so a half-written adapter is easy to fix.
 * @param {unknown} value
 * @param {string} [where] diagnostic context.
 * @returns {WechatConnection}
 */
export function assertConnection(value, where = 'connection') {
  if (!isConnection(value)) {
    const candidate = /** @type {Record<string, any>} */ (value ?? {});
    const missing = REQUIRED_MEMBERS.filter((key) => !(key in candidate));
    throw new TypeError(`${where} 不符合 Connection 契约，缺少：${missing.join(', ') || '对象本身'}`);
  }
  const connection = /** @type {WechatConnection} */ (value);
  if (!CONNECTION_IDS.includes(connection.id)) {
    throw new TypeError(`${where} 的 id 必须是 ${CONNECTION_IDS.join(' | ')}，实际为 ${String(connection.id)}`);
  }
  return connection;
}
