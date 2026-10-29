/**
 * WechatPadService — the plugin's runtime.
 *
 * It owns five things and nothing else:
 *  1. the live Config (Cordis gives the plugin a fresh service on a remount);
 *  2. one `WechatConnection` (see `connections/types.js`) — receive path and
 *     delivery, whichever protocol this profile speaks;
 *  3. the dsh side (owner Peer + HarnessBridge);
 *  4. the durable conversation routes and in-memory session cache;
 *  5. the status snapshot the Settings panel renders.
 *
 * Chat messages are ordinary queued prompts in a real dsh Session, so the UI,
 * tools, approvals, and history all behave exactly as they do for a typed
 * message. Replies are folded from the Session's own durable event stream.
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

import { outboundTarget, resolveConfig, chatSettingsFor } from './config.js';
import { DEFAULT_CAPABILITIES, createConnection, resolveProvider, safeSend } from './connections/index.js';
import { chunkText, applyPolicy, stripReasoning } from './inbound.js';
import { HarnessBridge, extractAssistantText } from './harness.js';
import { SessionDelivery } from './session-delivery.js';
import { extractReplyMedia } from './reply-media.js';
import { MessageInbox } from './message-inbox.js';
import { GroupContext, withGroupContext } from './group-context.js';
import { chalk } from './outbound.js';
import { QuestionRelay } from './questions.js';
import { NotificationRelay } from './notifications.js';
import {
  describeSettingsEntry, panelReadModel, persistedFormValue, resetPanelSettings, savePanelSettings,
} from './settings-bridge.js';
import { DedupeWindow } from './transport.js';
import { WS_PATH } from './ws-route.js';
import { stageMedia } from './media.js';
import { conversationCatalogFor } from './conversations.js';
import { outboundArtifactRegistry, materializeOutboundArtifact, releaseOutboundArtifact, prepareReplyMedia } from './vendor/artifact.js';

const STATUS_LINE_INTERVAL_MS = 3_000;

/** Keep simple peer ids readable while making arbitrary WeChat ids safe path segments. */
export function workspaceForChat(provider, chatId) {
  const id = String(chatId ?? '');
  const segment = /^[A-Za-z0-9_-]{1,100}$/.test(id)
    ? id : `chat-${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
  return provider === 'weixin'
    ? dshHomePath('wechat', 'weixin', segment)
    : dshHomePath('wechat', segment);
}

class SingleConnectionService {
  #ctx;
  #config;
  #rawConfig;
  #logger;
  #createConnection;
  #connection = null;
  #connectionStarted = false;
  #connectionState = null;
  #providerId = '';
  #peer = null;
  #bridge = null;
  #questions = null;
  #inbox = null;
  #dedupe = new DedupeWindow();
  #sessions = new Map();
  #sessionResets = new Map();
  #turns = new Map();
  #delivery = null;
  #webhookToken = randomUUID();
  #state = { phase: 'idle', since: Date.now(), lastError: '', messagesIn: 0, messagesOut: 0 };
  #received = 0;
  #ignored = 0;
  #lastIgnored = null;
  #sendQueues = new Map();
  #downloads = new Map();
  #mediaLifetime = new AbortController();
  #disposed = false;
  #droppedGroups = new Map();
  #groupsLoaded = false;
  #groupsWritePending = false;
  #groupContext = new GroupContext();

  /**
   * @param {object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx
   * @param {Record<string, unknown>} options.config parsed Config output.
   * @param {(level: string, msg: string) => void} [options.logger]
   * @param {(config: Record<string, any>, options?: object) => Promise<import('./connections/types.js').WechatConnection>} [options.createConnection]
   *   overrides the protocol selector. Production always uses the default, so a
   *   deployment can never point the service at a different adapter by accident;
   *   this seam exists so tests (and a future multi-account host) can supply one.
   */
  constructor({ ctx, config, logger, createConnection: create }) {
    this.#ctx = ctx;
    this.#logger = logger ?? (() => {});
    this.#rawConfig = config;
    this.#config = resolveConfig(config);
    this.#createConnection = create ?? createConnection;
  }

  get config() {
    return this.#config;
  }

  reconfigure(config) {
    this.#rawConfig = config;
    this.#config = resolveConfig(config);
  }

  /** Open the configured connection. Never throws for the plugin. */
  async start() {
    if (this.#disposed) return;
    if (!this.#config.enabled) {
      this.#setState('disabled', '插件已关闭');
      return;
    }
    const target = outboundTarget(this.#config);
    // A profile that predates `provider` is a Pad profile and keeps the exact
    // "unconfigured" gate it always had; another protocol decides for itself.
    if (this.#configuredProvider() === 'pad' && !target.configured) {
      this.#setState('unconfigured', this.#config.receiveMode === 'bridge'
        ? 'Bridge 模式需要填写 Bridge 地址和机器人 wxid'
        : '尚未填写 WechatPad 地址或 key，请在「设置 → 微信」中配置');
      return;
    }
    await this.#loadGroups();
    await this.#groupContext.load().catch((error) => this.#logger('warn', `读取群聊上下文失败：${error?.message ?? error}`));
    await this.#buildRuntimes();
    await this.#startConnection();
  }

  /** Stop every runtime piece and release the Peer. */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#stopRuntimes();
    await this.#groupContext.flush().catch((error) => this.#logger('warn', `保存群聊上下文失败：${error?.message ?? error}`));
    await Promise.allSettled([...this.#sessionResets.values()]);
    this.#sessions.clear();
    this.#setState('stopped', '已停止');
  }

  // ── 运行期装配 ────────────────────────────────────────────────────────────

  /** The protocol this profile speaks; a missing field means Pad. */
  #configuredProvider() {
    if (!this.#providerId) this.#providerId = resolveProvider(this.#config);
    return this.#providerId;
  }

  async #buildRuntimes() {
    this.#mediaLifetime = new AbortController();
    // Receive path and delivery live behind the Connection contract; everything
    // dsh-side (Peer, HarnessBridge, questions, inbox) is protocol-neutral.
    this.#connection = await this.#createConnection(this.#config, {
      ctx: this.#ctx,
      logger: this.#logger,
      webhookToken: this.#webhookToken,
    });
    this.#providerId = this.#connection.id;
    this.#peer = this.#ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
    this.#bridge = new HarnessBridge({
      gateway: this.#ctx.typertGateway,
      peer: this.#peer,
      ctx: this.#ctx,
      logger: this.#logger,
      timeZone: process.env.TZ && process.env.TZ !== 'UTC' ? process.env.TZ : 'Asia/Shanghai',
    });
    this.#questions = new QuestionRelay({
      ctx: this.#ctx,
      send: (chatId, text) => this.#sendReply(chatId, text),
      logger: this.#logger,
    });
    const catalog = conversationCatalogFor(this.#ctx, {logger:this.#logger});
    await catalog.ready;
    this.#delivery = new SessionDelivery({
      ctx:this.#ctx, catalog, provider:this.#configuredProvider(), logger:this.#logger,
      onEvent:(owner,event,turn) => this.#handleDeliveryEvent(owner,event,turn),
      onCancel:(owner,turn) => this.#stopDelivery(this.#deliveryKey(owner.sessionId,turn)),
    });
    this.#logger('info', `微信出站监听已就绪：${this.#configuredProvider()}（常驻）`);
    this.#inbox = new MessageInbox({
      dispatch: (message, isCurrent) => this.#submitMessage(message, isCurrent),
      onError: (message, error) => this.#reportInboundError(message, error),
    });
  }

  /** Start the connection and pump its events into the service. */
  async #startConnection() {
    const connection = this.#connection;
    if (!connection) return;
    this.#connectionStarted = true;
    try {
      await connection.start({
        onMessage: (message) => this.#handleInbound(message),
        onState: (state) => this.#handleConnectionState(state),
        onLog: (level, message) => this.#logger(level, message),
        onControl: (event) => this.#handleControl(event),
      });
    } catch (error) {
      if (this.#disposed) return;
      this.#setState('error', String(error?.message ?? error));
    }
  }

  /**
   * Fold one connection state update into the panel's phase.
   *
   * `unconfigured` means "the profile has not been filled in yet" and keeps its
   * own phase; any other phase an adapter reports is a connection error.
   */
  #handleConnectionState(state) {
    if (this.#disposed || !state) return;
    this.#connectionState = state;
    if (state.phase === 'connected') {
      this.#setState('connected', '', state.label);
      return;
    }
    if (state.phase === 'unconfigured' || state.missing) {
      this.#setState('unconfigured', state.error ?? state.label ?? '');
      return;
    }
    if (state.phase === 'idle') return;
    if (state.phase === 'error') {
      this.#setState('error', state.error ?? state.label ?? '');
      return;
    }
    this.#setState(state.phase, state.error ?? '', state.label);
  }

  /** Protocol control traffic the service only has to surface. */
  #handleControl(event) {
    if (this.#disposed || !event) return;
    if (event.kind === 'error' || event.kind === 'warning') {
      this.#logger('warn', `微信通道 ${event.kind}：${event.detail ?? ''}`);
    }
  }

  /** Stop the connection and release everything around it. */
  async #stopRuntimes() {
    this.#mediaLifetime.abort();
    this.#delivery?.dispose();
    this.#delivery = null;
    for (const chatId of this.#downloads.keys()) this.#cancelMedia(chatId);
    this.#inbox?.dispose();
    this.#inbox = null;
    this.#questions?.dispose();
    this.#questions = null;
    const connection = this.#connection;
    const started = this.#connectionStarted;
    this.#connection = null;
    this.#connectionStarted = false;
    if (connection && started) {
      try {
        await connection.stop();
      } catch (error) {
        this.#logger('debug', `停止微信连接失败：${error?.message ?? error}`);
      }
    }
    for (const key of [...this.#turns.keys()]) this.#stopDelivery(key);
    const peer = this.#peer;
    this.#peer = null;
    if (peer) await peer.dispose().catch(() => {});
    this.#bridge?.dispose?.();
    this.#bridge = null;
  }

  // ── 发送 ──────────────────────────────────────────────────────────────────

  /**
   * Deliver one reply: shaping stays here (it is policy, not protocol), the
   * connection only has to get one plain chunk out.
   */
  async #sendReply(chatId, text, options = {}) {
    const maxChunkLength = options.maxChunkLength ?? chatSettingsFor(resolveConfig(this.#rawConfig), this.#configuredProvider(), chatId).maxReplyChunkLength;
    const cleaned = stripReasoning(text);
    if (!cleaned) return { ok: false, delivered: 0, error: 'empty reply' };
    const chunks = chunkText(cleaned, maxChunkLength).map((chunk) => chalk(chunk));
    let delivered = 0;
    for (const chunk of chunks) {
      const result = await this.#sendText(chatId, chunk, options.signal);
      if (!result.ok) return { ok: false, delivered, error: result.error };
      delivered += 1;
    }
    return { ok: true, delivered };
  }

  /**
   * One already-clean text message. Never throws: `safeSend` converts a refusal
   * or a broken adapter into `{ ok: false, error }`, so callers may ignore it.
   */
  #enqueueSend(chatId, send) {
    const previous = this.#sendQueues.get(chatId) ?? Promise.resolve();
    const next = previous.then(send, send);
    this.#sendQueues.set(chatId, next);
    void next.finally(() => { if (this.#sendQueues.get(chatId) === next) this.#sendQueues.delete(chatId); }).catch(() => {});
    return next;
  }
  #sendText(chatId, text, signal) {
    const connection = this.#connection;
    return this.#enqueueSend(chatId, () => this.#disposed || signal?.aborted || this.#connection !== connection
      ? { ok: false, delivered: 0, error: '连接已停止' } : safeSend(connection, { chatId, text }));
  }
  sendNotification(chatId, text) {
    if (!this.#config.enabled || !this.#connectionStarted) return { ok: false, error: '通知连接未启用' };
    return this.#sendReply(chatId, text);
  }
  #cancelMedia(chatId) {
    for (const controller of this.#downloads.get(chatId) ?? []) controller.abort();
    this.#downloads.delete(chatId);
  }

  // ── 接收 ──────────────────────────────────────────────────────────────────

  /** One normalized message from the connection; policy and routing are here. */
  async #handleInbound(message) {
    if (this.#disposed || !this.#bridge || !this.#connection) return;
    const key = message.messageId || `${message.chatId}:${message.createdAt}:${message.text}`;
    if (this.#dedupe.duplicate(key)) return;
    this.#received += 1;

    // The original group sender may answer a pending question without another @.
    // Group/DM allowlists and self-echo checks still apply.
    const answering = this.#questions?.canAnswer(message);
    // The QR bot does not use Pad's DM access policy or identity. Its own
    // enable switch controls reception; protocol echo/empty/system filtering
    // still applies. Pad and Bridge retain their configured access controls.
    const weixin = this.#configuredProvider() === 'weixin';
    const accessConfig = weixin ? { ...this.#config, dmPolicy: 'open', selfWxid: '' } : this.#config;
    const policy = applyPolicy(answering ? { ...message, mentioned: true } : message, accessConfig, accessConfig.selfWxid);
    if (!policy.allowed) {
      this.#ignored += 1;
      const previous = this.#lastIgnored;
      this.#lastIgnored = { reason: policy.reason, senderId: message.senderId, isGroup: Boolean(message.isGroup), at: Date.now() };
      if (!previous || previous.reason !== policy.reason || previous.senderId !== message.senderId || Date.now() - previous.at > 60000) {
        this.#logger('warn', `${this.#configuredProvider()} 消息被访问策略拦截（${policy.reason}）`);
      }
      // Every dropped group message still names its group; that id is what an
      // operator needs for `allowedGroups`. Record it before dropping so the
      // settings page can list live groups instead of sending them to logs.
      if (message.isGroup) this.#noteDroppedGroup(message);
      if (message.isGroup && (policy.reason === 'group-other-mentioned' || policy.reason === 'group-not-mentioned')) {
        await this.#groupContext.remember(this.#configuredProvider(), message)
          .catch((error) => this.#logger('warn', `保存群聊上下文失败：${error?.message ?? error}`));
      }
      this.#logger('debug', `微信消息被策略忽略（${policy.reason}）：${message.chatId}`);
      return;
    }
    this.#state.messagesIn += 1;
    this.#setState('connected', '');
    if (message.isGroup) message.groupContextCursor = this.#groupContext.cursor();
    try {
      await this.#routeMessage(message);
    } catch (error) {
      await this.#reportInboundError(message, error);
    }
  }

  async #reportInboundError(message, error) {
    this.#setState('error', String(error?.message ?? error));
    this.#logger('error', `处理微信消息失败：${error?.message ?? error}`);
    await this.#sendText(message.chatId, `处理失败：${error?.message ?? error}`);
  }

  /**
   * Record every group this plugin actually received.
   *
   * This is the ONLY source of the group inventory: the list is what this
   * bridge instance dropped, never what some shared log happened to contain
   * (other bots' traffic lives in the same Bridge log and must not leak here).
   * The inventory is persisted so a restart keeps naming groups before they
   * speak again.
   */
  #noteDroppedGroup(message) {
    const id = message.chatId;
    if (!id || !id.endsWith('@chatroom')) return;
    const seen = this.#droppedGroups.get(id) ?? { chatId: id, count: 0, lastAt: 0, sample: '' };
    seen.count += 1;
    seen.lastAt = Math.max(seen.lastAt, message.createdAt || Date.now());
    if (!seen.sample && message.text) seen.sample = String(message.text).slice(0, 40);
    const isNew = !this.#droppedGroups.has(id);
    this.#droppedGroups.set(id, seen);
    if (isNew) this.#logger('info', `发现群聊 ${id}（当前群聊策略不会处理）；可在设置白名单中启用`);
    void this.#persistGroups();
  }

  /** Where the discovered group inventory lives. */
  #groupsPath() {
    return dshHomePath('wechatpad', 'groups.json');
  }

  /** Load the persisted inventory once, before the first group is recorded. */
  async #loadGroups() {
    if (this.#groupsLoaded) return;
    this.#groupsLoaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#groupsPath(), 'utf8'));
      const rows = Array.isArray(parsed?.groups) ? parsed.groups : [];
      for (const row of rows) {
        if (row && typeof row.chatId === 'string' && row.chatId.endsWith('@chatroom')) {
          this.#droppedGroups.set(row.chatId, {
            chatId: row.chatId,
            count: Number(row.count) || 0,
            lastAt: Number(row.lastAt) || 0,
            sample: String(row.sample ?? ''),
          });
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#logger('warn', `读取群聊清单失败：${error?.message ?? error}`);
    }
  }

  async #persistGroups() {
    if (this.#groupsWritePending) return;
    this.#groupsWritePending = true;
    try {
      await mkdir(dshHomePath('wechatpad'), { recursive: true, mode: 0o700 });
      const groups = [...this.#droppedGroups.values()]
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, 500);
      await writeFile(this.#groupsPath(), `${JSON.stringify({ version: 1, groups }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      this.#logger('debug', `保存群聊清单失败：${error?.message ?? error}`);
    } finally {
      this.#groupsWritePending = false;
    }
  }

  async #routeMessage(message) {
    const prefix = this.#config.commandPrefix;
    const text = String(message.text ?? '').trim();
    const command = prefix && text.startsWith(prefix) ? text.slice(prefix.length).trim().toLowerCase() : '';
    if (!message.attachments?.length && ['stop', 'new', 'reset', 'status', 'help'].includes(command.split(/\s+/)[0])) {
      await this.#runCommand(command, message);
      return;
    }
    // Do not yield on an absent question: a following /stop must see and clear
    // the earlier message's batch, rather than racing ahead of its admission.
    if (!message.attachments?.length && this.#questions?.canAnswer(message) && await this.#questions.answer(message)) return;
    const config = chatSettingsFor(resolveConfig(this.#rawConfig), this.#configuredProvider(), message.chatId);
    return this.#inbox.add(message, config.messageMergeDelaySeconds * 1000);
  }

  async #submitMessage(message, isCurrent) {
    const sessionId = await this.#sessionFor(message.chatId, isCurrent);
    if (!sessionId || !isCurrent()) return;
    const config = chatSettingsFor(resolveConfig(this.#rawConfig), this.#configuredProvider(), message.chatId);
    let prepared = { text: message.text, images: [] };
    if (message.attachments?.length) {
      const controller = new AbortController();
      const downloads = this.#downloads.get(message.chatId) ?? new Set();
      downloads.add(controller); this.#downloads.set(message.chatId, downloads);
      try {
        const local = this.#ctx.get?.('sessions')?.get?.(sessionId);
        const summary = local?.header ?? await this.#bridge.sessionSummary(sessionId).catch(() => null);
        prepared = await stageMedia(message, {
          workspace: summary?.cwd ?? summary?.workspace?.path ?? (config.cwd || workspaceForChat(this.#configuredProvider(), message.chatId)),
          provider: this.#configuredProvider(), ctx: this.#ctx,
          signal: AbortSignal.any([controller.signal, this.#mediaLifetime.signal]),
        });
      } finally { downloads.delete(controller); if (!downloads.size) this.#downloads.delete(message.chatId); }
      if (!isCurrent()) { if (prepared.directory) await rm(prepared.directory, { recursive: true, force: true }); return; }
    }
    if (config.incomingMessageMode === 'interrupt') {
      // DSH cancel preserves the pending inbox; do not silently discard queued work.
      await this.#bridge.cancel(sessionId);
      if (!isCurrent()) return;
      this.#questions.cancelChat(message.chatId);
      this.#finishTurn(message.chatId);
    }
    const requestId = randomUUID();
    const contextCursor = message.groupContextCursor ?? this.#groupContext.cursor();
    const context = message.isGroup
      ? this.#groupContext.snapshot(this.#configuredProvider(), message.chatId, contextCursor) : [];
    this.#delivery.trackPrompt(requestId, sessionId, message.chatId);
    const catalog = conversationCatalogFor(this.#ctx, { logger: this.#logger });
    catalog.track(sessionId, requestId, message, prepared);
    this.#questions.trackPrompt({ requestId, sessionId, chatId: message.chatId, senderId: message.senderId });
    try {
      await this.#bridge.prompt({ sessionId, text: withGroupContext(prepared.text, context), images: prepared.images, requestId });
      if (context.length) await this.#groupContext.clearThrough(this.#configuredProvider(), message.chatId, contextCursor)
        .catch((error) => this.#logger('warn', `清理已使用群聊上下文失败：${error?.message ?? error}`));
    } catch (error) {
      this.#questions.forgetPrompt(requestId);
      this.#delivery?.forgetPrompt(requestId);
      catalog.forget(requestId);
      throw error;
    }
    this.#logger('info', `微信 ${message.chatId} → 会话 ${sessionId}（${config.incomingMessageMode === 'interrupt' ? '打断' : '排队'}）`);
  }

  async #runCommand(command, message) {
    const [verb] = command.split(/\s+/);
    const send = (chatId, body) => this.#sendText(chatId, body);
    if (verb === 'new' || verb === 'reset') {
      await this.#groupContext.clear(this.#configuredProvider(), message.chatId)
        .catch((error) => this.#logger('warn', `清理群聊上下文失败：${error?.message ?? error}`));
      this.#cancelMedia(message.chatId);
      this.#inbox?.cancelChat(message.chatId);
      this.#questions?.cancelChat(message.chatId);
      const previous = this.#sessionResets.get(message.chatId) ?? Promise.resolve();
      const reset = previous.catch(() => {}).then(async () => {
        const old = await this.#currentSession(message.chatId);
        await conversationCatalogFor(this.#ctx, { logger: this.#logger }).reset(this.#configuredProvider(), message.chatId);
        this.#sessions.delete(message.chatId);
        this.#finishTurn(message.chatId);
        await send(message.chatId, old ? '已开启新会话，之前的上下文不再引用。' : '当前还没有会话，直接发消息即可开始。');
      });
      this.#sessionResets.set(message.chatId, reset);
      try { await reset; } finally { if (this.#sessionResets.get(message.chatId) === reset) this.#sessionResets.delete(message.chatId); }
      return true;
    }
    if (verb === 'stop') {
      this.#cancelMedia(message.chatId);
      this.#inbox?.cancelChat(message.chatId);
      this.#questions?.cancelChat(message.chatId);
      const session = await this.#currentSession(message.chatId);
      if (!session) {
        await send(message.chatId, '当前没有可停止的会话。');
        return true;
      }
      await this.#bridge.cancel(session.sessionId).catch(() => {});
      this.#finishTurn(message.chatId);
      await send(message.chatId, '已请求停止当前运行。');
      return true;
    }
    if (verb === 'status') {
      const session = await this.#currentSession(message.chatId);
      const phase = this.#state.phase;
      await send(message.chatId, [
        `微信通道：${this.#labelOf(phase)}`,
        session ? `当前会话：${session.title || session.sessionId}` : '当前会话：无',
        `收发统计：收 ${this.#state.messagesIn} / 发 ${this.#state.messagesOut}`,
      ].join('\n'));
      return true;
    }
    if (verb === 'help') {
      await send(message.chatId, [
        `可用命令（前缀 ${prefixOf(this.#config.commandPrefix)}）：`,
        '/new 开启新会话',
        '/stop 停止当前运行',
        '/status 查看通道与会话状态',
        '收到提问后回复选项编号或文字；/skip 跳过提问',
      ].join('\n'));
      return true;
    }
    return false;
  }

  // Current routes survive reloads; only explicit reset or confirmed deletion creates a new Session.
  async #currentSession(chatId) {
    const cached = this.#sessions.get(chatId);
    if (cached) return cached;
    const sessionId = await conversationCatalogFor(this.#ctx, { logger: this.#logger }).current(this.#configuredProvider(), chatId);
    return sessionId ? { sessionId, title: '' } : null;
  }

  async #sessionFor(chatId, isCurrent = () => true) {
    await this.#sessionResets.get(chatId);
    if (!isCurrent()) return null;
    const catalog = conversationCatalogFor(this.#ctx, { logger: this.#logger });
    const details = { provider: this.#configuredProvider(), chatId };
    const existing = await this.#currentSession(chatId);
    if (!isCurrent()) return null;
    if (existing) {
      // A failed lookup is unknown, not proof of deletion: let prompt report
      // the error rather than silently discarding the user's conversation.
      const alive = await this.#bridge.sessionExists(existing.sessionId).catch(() => true);
      if (!isCurrent()) return null;
      if (alive) {
        await catalog.register(existing.sessionId, details, { isCurrent });
        if (!isCurrent()) return null;
        if (!this.#sessions.has(chatId)) this.#logger('info', `微信 ${chatId} 恢复会话 ${existing.sessionId}`);
        this.#sessions.set(chatId, existing);
        return existing.sessionId;
      }
      await catalog.reset(details.provider, chatId, { isCurrent });
      this.#sessions.delete(chatId);
      if (!isCurrent()) return null;
    }
    const settings = chatSettingsFor(resolveConfig(this.#rawConfig), this.#configuredProvider(), chatId);
    const cwd = settings.cwd || workspaceForChat(this.#configuredProvider(), chatId);
    if (!settings.cwd) await mkdir(cwd, { recursive: true, mode: 0o700 });
    const sessionId = await this.#bridge.createSession({
      cwd,
      agentPreset: this.#config.agentPreset || undefined,
    });
    if (!isCurrent()) return null;
    // Retain a created id if persistence fails so a retry cannot create another
    // empty Session. No prompt is admitted until its route is safely saved.
    this.#sessions.set(chatId, { sessionId, title: '' });
    await catalog.register(sessionId, details, { isCurrent });
    if (!isCurrent()) return null;
    this.#logger('info', `微信 ${chatId} 新建会话 ${sessionId}`);
    return sessionId;
  }

  #deliveryKey(sessionId, turn) { return `${sessionId}:${turn}`; }
  #handleDeliveryEvent(owner, event, number) {
    const turn = this.#ensureDelivery(owner, number);
    if (event.type === 'turn/end') return turn.handlers.onTurnEnd(event.data ?? {});
    if (event.type === 'assistant/message') {
      const text = extractAssistantText(event); if (text) turn.handlers.onText(text);
    } else if (event.type === 'tool/call' || event.type === 'tool/call-start') {
      turn.handlers.onProgress({tool:event.data?.name ?? event.data?.call?.name ?? event.data?.tool});
    } else if (event.type === 'turn/error' || event.type === 'agent/error') {
      turn.handlers.onError(new Error(event.data?.message || '运行出错'));
    }
  }
  #ensureDelivery(owner, number) {
    const {chatId, sessionId} = owner;
    const key = this.#deliveryKey(sessionId,number);
    const existing = this.#turns.get(key); if (existing) return existing;
    const settings = chatSettingsFor(resolveConfig(this.#rawConfig), this.#configuredProvider(), chatId);
    const turn = {
      chatId, sessionId, activeTurn:number, controller:new AbortController(), buffers:[], timer:null,
      statusSentAt:0, progress:'', sent:false, sending:Promise.resolve(), handlers:null, markedFiles:new Map(),
      mergeReplies:settings.mergeReplies, showProgress:settings.showProgress, maxChunkLength:settings.maxReplyChunkLength,
    };
    const flush = () => {
      turn.timer = null;
      const text = turn.buffers.join('\n\n').trim(); turn.buffers = [];
      turn.sending = turn.sending.then(async () => {
        if (!text || this.#disposed || turn.controller.signal.aborted) return;
        turn.sent = true;
        this.#logger('info', `回复发送中 → ${chatId}（${text.length} 字）`);
        const result = await this.#sendReply(chatId, text, {maxChunkLength:turn.maxChunkLength, signal:turn.controller.signal});
        if (turn.controller.signal.aborted) return;
        if (result?.ok) {
          this.#state.messagesOut += result.delivered;
          this.#logger('info', `回复已发送 → ${chatId}（${result.delivered} 条）`);
        } else {
          this.#logger('error', `回复发送失败 → ${chatId}：${result?.error ?? '未知原因'}`);
          this.#setState('error', `回复发送失败：${result?.error ?? '未知原因'}`);
        }
      }).catch(error => this.#logger('error', `微信发送异常：${error.message}`));
      return turn.sending;
    };
    turn.handlers = {
      onTurnEnd: async (data) => {
        if (turn.timer) clearTimeout(turn.timer);
        turn.timer = null;
        const textDelivery = flush();
        const artifacts = outboundArtifactRegistry.take(sessionId, data.turn, { signal: turn.controller.signal });
        const sentFiles = new Set();
        const sendFile = async (file) => {
          const fingerprint = `${file.fileName}:${createHash('sha256').update(file.bytes).digest('hex')}`;
          if (sentFiles.has(fingerprint)) return;
          const connection = this.#connection;
          const result = await this.#enqueueSend(chatId, async () => {
            turn.controller.signal.throwIfAborted();
            if (this.#disposed || this.#connection !== connection) throw new Error('连接已停止');
            if (typeof connection?.sendFile !== 'function') throw new Error('当前连接未支持附件发送');
            return connection.sendFile({ chatId, file, signal: turn.controller.signal });
          });
          if (!result?.ok) throw new Error(result?.error || '微信拒绝了文件');
          sentFiles.add(fingerprint);
          this.#state.messagesOut += result.delivered ?? 1;
          this.#logger('info', `文件已发送 → ${chatId}（${file.size} 字节）`);
        };
        const reportFailure = async (error) => {
          if (turn.controller.signal.aborted) return;
          this.#setState('error', `文件发送失败：${error.message}`);
          this.#logger('error', `文件发送失败 → ${chatId}：${error.message}`);
          await this.#sendText(chatId, `文件发送失败：${error.message}`);
        };
        try {
          await textDelivery;
          for (const artifact of artifacts) {
            try {
              const file = await materializeOutboundArtifact(artifact, { signal: turn.controller.signal });
              await sendFile(file);
            } catch (error) {
              await reportFailure(error);
            } finally { releaseOutboundArtifact(artifact); }
          }
          for (const pending of turn.markedFiles.values()) {
            const prepared = await pending;
            try {
              if (prepared.error) throw prepared.error;
              await sendFile(prepared.file);
            } catch (error) { await reportFailure(error); }
          }
        } finally {
          for (const artifact of artifacts) releaseOutboundArtifact(artifact);
          this.#stopDelivery(key);
        }
      },
      onText: (text) => {
        this.#logger('info', `会话产出文本 ${text.length} 字（${chatId}）`);
        const session = this.#ctx.get?.('sessions')?.get?.(sessionId);
        const cwd = session?.header?.cwd || settings.cwd || workspaceForChat(this.#configuredProvider(), chatId);
        const media = extractReplyMedia(text, cwd);
        for (const path of media.paths) {
          if (turn.markedFiles.has(path)) continue;
          const pending = turn.markedFiles.size >= 16
            ? Promise.resolve({ error: new Error('单轮附件超过 16 个，请分批发送') })
            : prepareReplyMedia(path, { cwd, signal: turn.controller.signal }).then(file => ({ file }), error => ({ error }));
          turn.markedFiles.set(path, pending);
          if (turn.markedFiles.size > 16) break;
        }
        text = media.text;
        turn.progress = '';
        turn.buffers.push(text);
        if (!turn.mergeReplies) {
          if (turn.timer) clearTimeout(turn.timer);
          turn.timer = setTimeout(() => void flush(), 800);
        }
      },
      onProgress: ({ tool }) => {
        if (!turn.showProgress || turn.mergeReplies || !tool || tool === 'ask_user_question') return;
        turn.progress = tool;
        const now = Date.now();
        if (now - turn.statusSentAt < STATUS_LINE_INTERVAL_MS) return;
        turn.statusSentAt = now;
        void this.#sendText(chatId, `正在使用 ${tool}…`, turn.controller.signal);
      },
      onError: (error) => {
        this.#logger('error', `会话出错（${chatId}）：${error?.message ?? error}`);
        if (turn.sent) return;
        void this.#sendText(chatId, `运行出错：${error?.message ?? error}`, turn.controller.signal);
      },
    };
    this.#turns.set(key,turn);
    return turn;
  }
  #stopDelivery(key) {
    const turn = this.#turns.get(key); if (!turn) return;
    this.#turns.delete(key); turn.controller.abort();
    if (turn.timer) clearTimeout(turn.timer);
  }
  #finishTurn(chatId) {
    this.#delivery?.cancelChat(chatId);
    for (const [key,turn] of this.#turns) if (turn.chatId === chatId) this.#stopDelivery(key);
  }

  // ── 状态与设置面板 ────────────────────────────────────────────────────────

  #setState(phase, error) {
    if (this.#state.phase === phase && !error) return;
    this.#state.phase = phase;
    this.#state.since = Date.now();
    this.#state.lastError = error ?? (phase === 'error' ? this.#state.lastError : '');
  }

  #labelOf(phase) {
    return ({
      connected: '已连接', connecting: '连接中', reconnecting: '重连中', idle: '待机',
      error: '出错', disabled: '已关闭', unconfigured: '未配置', stopped: '已停止',
    })[phase] ?? phase;
  }

  /**
   * The panel's status snapshot.
   *
   * `provider`/`providerId` are the new, protocol-neutral fields; the legacy
   * Pad-shaped ones (`receiveMode`, `baseUrl`, `webhookUrl`, `keyConfigured`)
   * stay so an older panel build keeps rendering.
   */
  status() {
    const detail = this.#connectionDetail();
    return {
      phase: this.#state.phase,
      label: this.#labelOf(this.#state.phase),
      since: this.#state.since,
      lastError: this.#state.lastError,
      provider: this.#providerId || this.#configuredProvider(),
      providerId: this.#providerId || this.#configuredProvider(),
      providerLabel: this.#connection?.label ?? '',
      capabilities: { ...this.#capabilities() },
      receiveMode: this.#config.receiveMode,
      baseUrl: this.#config.baseUrl,
      delivery: this.#delivery?.status() ?? {listening:false,activeTurns:0,pendingPrompts:0},
      messagesReceived: this.#received,
      messagesIgnored: this.#ignored,
      lastIgnored: this.#lastIgnored,
      messagesIn: this.#state.messagesIn,
      messagesOut: this.#state.messagesOut,
      webhookUrl: typeof detail.webhookUrl === 'string' ? detail.webhookUrl : '',
      connected: typeof detail.connected === 'boolean' ? detail.connected : (this.#state.phase === 'connected'),
      keyConfigured: Boolean(this.#config.key || (this.#config.receiveMode === 'bridge' && this.#config.bridgeBaseUrl)),
      // The adapter's own status, unchanged, so a protocol-specific field (a
      // bound bot id, a QR state) reaches the panel without the service having
      // to know what it means. `detail` is the same record under a stable name.
      providerStatus: detail,
      detail,
    };
  }

  /** `status()` of the live connection, or an empty record. Never throws. */
  #connectionDetail() {
    try {
      const detail = this.#connection?.status?.();
      return detail && typeof detail === 'object' ? detail : {};
    } catch (error) {
      this.#logger('debug', `读取连接状态失败：${error?.message ?? error}`);
      return {};
    }
  }

  /** Capabilities of the live connection, defaulting to none. */
  #capabilities() {
    const capabilities = this.#connection?.capabilities;
    return capabilities && typeof capabilities === 'object' ? capabilities : { ...DEFAULT_CAPABILITIES };
  }

  /** The panel's read model: every editable field, with the secret redacted. */
  panelSettings() {
    const descriptor = describeSettingsEntry(this.#ctx);
    // Prefer the persisted patch while the coordinator reconciles the
    // connection's snapshot after a volatile settings write.
    const persisted = persistedFormValue(this.#ctx);
    const merged = persisted ? { ...this.#config, ...stripUndefined(persisted) } : this.#config;
    return {
      settings: panelReadModel(merged),
      defaults: resolveConfig({}),
      entryId: descriptor.ns,
      revision: descriptor.revision,
      readable: descriptor.readable,
      reason: descriptor.reason,
    };
  }

  /**
   * Apply the panel's edits. Writes go back through the dsh Settings service,
   * which validates them against this plugin's Config and persists them in the
   * profile's Cordis patch; the coordinator then reconciles live connections.
   */
  async updateSettings(patch, expectedRevision) {
    const descriptor = describeSettingsEntry(this.#ctx);
    return savePanelSettings({
      ctx: this.#ctx,
      patch,
      expectedRevision: expectedRevision ?? descriptor.revision,
    });
  }

  async resetSettings(expectedRevision) {
    const descriptor = describeSettingsEntry(this.#ctx);
    return resetPanelSettings({ ctx: this.#ctx, expectedRevision: expectedRevision ?? descriptor.revision });
  }

  /**
   * Probe the configured protocol without changing runtime state.
   *
   * When there is no live connection (the service never started, or the
   * profile is still unconfigured) a throwaway connection is created so the
   * panel's "test" button keeps working — that is the state a user is in when
   * they open the panel to fix a wrong key.
   */
  async testConnection() {
    let connection = this.#connection;
    if (!connection) {
      connection = await this.#createConnection(this.#config, {
        ctx: this.#ctx,
        logger: this.#logger,
        webhookToken: this.#webhookToken,
      });
    }
    const detail = this.#connectionDetail();
    try {
      const result = await connection.test();
      const probe = result && typeof result === 'object' ? result : { ok: false, detail: '连接未返回检测结果' };
      return {
        ...probe,
        provider: connection.id,
        receiveMode: this.#config.receiveMode,
        webhookUrl: typeof detail.webhookUrl === 'string' ? detail.webhookUrl : '',
      };
    } catch (error) {
      return { ok: false, provider: connection.id, detail: '检测失败', error: String(error?.message ?? error) };
    }
  }

  /**
   * Forward an optional account-lifecycle call to the connection.
   *
   * The Pad answers `{ supported: false }` for all of these; a QR-binding
   * protocol implements them. Failures are reported, never thrown, so the
   * settings page always gets a renderable answer.
   * @param {'beginLogin' | 'pollLogin' | 'cancelLogin' | 'resetAccount'} method
   * @param {unknown[]} args
   */
  async #lifecycle(method, args) {
    const connection = this.#connection;
    const call = connection?.[method];
    if (typeof call !== 'function') {
      return { supported: false, detail: `当前连接（${connection?.id ?? this.#configuredProvider()}）不支持该操作` };
    }
    try {
      const result = await call.apply(connection, args);
      return result && typeof result === 'object' ? result : { supported: false, detail: '连接未返回结果' };
    } catch (error) {
      return { supported: false, error: String(error?.message ?? error) };
    }
  }

  /** Start a QR/binding login for protocols that have one. */
  async beginLogin(options) {
    return this.#lifecycle('beginLogin', [options]);
  }

  /** Poll one pending binding attempt. */
  async pollLogin(attemptId) {
    return this.#lifecycle('pollLogin', [String(attemptId ?? '')]);
  }

  /** Abandon one pending binding attempt. */
  async cancelLogin(attemptId) {
    return this.#lifecycle('cancelLogin', [String(attemptId ?? '')]);
  }

  /** Forget the bound account (protocol-specific meaning). */
  async resetAccount() {
    return this.#lifecycle('resetAccount', []);
  }

  /**
   * Show or clear the "is typing" indicator. The Pad has none, so this reports
   * `false` instead of pretending. Never throws.
   * @returns {Promise<boolean>} whether the indicator was actually set.
   */
  async typing(chatId, on) {
    const call = this.#connection?.typing;
    if (typeof call !== 'function') return false;
    try {
      return Boolean(await call.call(this.#connection, String(chatId ?? ''), Boolean(on)));
    } catch (error) {
      this.#logger('debug', `输入状态设置失败：${error?.message ?? error}`);
      return false;
    }
  }

  async reconnect() {
    await this.#stopRuntimes();
    this.#disposed = false;
    this.#received = 0; this.#ignored = 0; this.#lastIgnored = null;
    this.#state.messagesIn = 0;
    this.#state.messagesOut = 0;
    await this.start();
    return this.status();
  }

  /** Groups seen while group chat is off — candidates for the allowlist. */
  listSeenGroups() {
    return {
      items: [...this.#droppedGroups.values()]
        .sort((a, b) => b.lastAt - a.lastAt)
        .map((item) => ({ ...item })),
    };
  }

}

/** Each protocol owns its sessions, dedupe, inbox, questions and outbound path.
 * Reconnecting one channel cannot cancel the other channel's active work. */
export class WechatPadService {
  #notifications = null;
  #options;
  #services = new Map();
  #config;
  #transition = Promise.resolve();
  #disposed = false;
  constructor(options) {
    this.#options = options;
    this.#config = resolveConfig(options.config);
    const ids = new Set([this.#config.provider, ...this.#config.enabledProviders]);
    for (const provider of ids) {
      this.#services.set(provider, new SingleConnectionService({ ...options, config: {
        ...options.config, provider,
        enabled: this.#config.enabled && this.#config.enabledProviders.includes(provider),
      } }));
    }
  }
  renameConversationGroup(groupKey, name) { return conversationCatalogFor(this.#options.ctx, { logger: this.#options.logger }).renameGroup(groupKey, name); }
  listConversations() { return conversationCatalogFor(this.#options.ctx, { logger: this.#options.logger }).list(); }
  get config() { return this.#config; }
  #primary() { return this.#services.get(this.#config.provider); }
  #get(provider) {
    const id = provider ?? this.#config.provider;
    if (!['pad', 'weixin'].includes(id)) throw new TypeError('未知的连接');
    const service = this.#services.get(id);
    if (!service) throw new Error('请先启用并保存此连接');
    return service;
  }
  async start() {
    const pending = this.#transition.then(() => Promise.all([...this.#services.values()].map((service) => service.start())));
    this.#transition = pending.catch(() => {});
    await pending;
    if (!this.#disposed && !this.#notifications) this.#notifications = new NotificationRelay({
      ctx: this.#options.ctx,
      config: () => this.#readConfig(),
      send: (provider, chatId, text) => this.#get(provider).sendNotification(chatId, text),
      logger: this.#options.logger,
    });
  }
  async dispose() {
    this.#disposed = true;
    this.#notifications?.dispose();
    this.#notifications = null;
    await this.#transition.catch(() => {});
    await Promise.all([...this.#services.values()].map((service) => service.dispose()));
    await conversationCatalogFor(this.#options.ctx).flush();
  }
  #readConfig() {
    const live = resolveConfig(this.#options.config);
    return resolveConfig({ ...live, ...stripUndefined(persistedFormValue(this.#options.ctx) ?? {}) });
  }
  #synchronize() {
    const apply = async () => {
      if (this.#disposed) return;
      const next = this.#readConfig();
      const previous = this.#config;
      if (JSON.stringify(next) === JSON.stringify(previous)) return;
      const common = ['requestTimeoutSeconds'];
      const transportFields = {
        pad: [...common, 'baseUrl', 'key', 'apiPrefix', 'wxid', 'receiveMode', 'webhookHost', 'webhookPath', 'bridgeBaseUrl', 'bridgeToken', 'bridgeAccounts', 'bridgeClientId', 'selfWxid', 'selfNickname'],
        weixin: ['weixinAccountFile', 'weixinBotType', 'weixinTyping', 'weixinReplyQuote'],
      };
      this.#config = next;
      for (const id of new Set([next.provider, ...this.#services.keys(), ...next.enabledProviders])) {
        if (this.#disposed) return;
        const enabled = next.enabled && next.enabledProviders.includes(id);
        const wasEnabled = previous.enabled && previous.enabledProviders.includes(id);
        const config = { ...next, provider: id, enabled };
        const service = this.#services.get(id);
        if (!service) {
          const created = new SingleConnectionService({ ...this.#options, config });
          this.#services.set(id, created);
          await created.start();
        } else {
          service.reconfigure(config);
          if (enabled !== wasEnabled || (enabled && transportFields[id].some((field) => next[field] !== previous[field]))) {
            await service.reconnect();
          }
        }
      }
    };
    const pending = this.#transition.then(apply);
    this.#transition = pending.catch(() => {});
    return pending;
  }
  status() {
    // Volatile settings can also be edited through dsh's generic plugin form.
    // Schedule reconciliation there without making the status read asynchronous.
    void this.#synchronize().catch((error) => this.#options.logger?.('error', `应用微信连接配置失败：${error.message}`));
    const connections = Object.fromEntries([...this.#services].map(([id, service]) => [id, service.status()]));
    return { ...this.#primary().status(), connections };
  }
  panelSettings() {
    const model = this.#primary().panelSettings();
    const persisted = persistedFormValue(this.#options.ctx);
    model.settings = panelReadModel({ ...this.#config, ...stripUndefined(persisted ?? {}) });
    return model;
  }
  async updateSettings(patch, revision) {
    const result = await this.#primary().updateSettings(patch, revision);
    await this.#synchronize();
    return result;
  }
  async resetSettings(revision) {
    const result = await this.#primary().resetSettings(revision);
    await this.#synchronize();
    return result;
  }
  async testConnection(provider) { await this.#synchronize(); return this.#get(provider).testConnection(); }
  async reconnect(provider) { await this.#synchronize(); await this.#get(provider).reconnect(); return this.status(); }
  async beginLogin(options) { await this.#synchronize(); return this.#get('weixin').beginLogin(options); }
  pollLogin(ticket) { return this.#get('weixin').pollLogin(ticket); }
  cancelLogin(ticket) { return this.#get('weixin').cancelLogin(ticket); }
  resetAccount() { return this.#get('weixin').resetAccount(); }
  typing(chatId, on, provider) { return this.#get(provider).typing(chatId, on); }
  listSeenGroups() { return this.#services.get('pad')?.listSeenGroups() ?? { items: [] }; }
}

/** Drop keys whose value is undefined so a spread cannot erase a real value. */
function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

/** Absolute URL of the webhook the Pad should call, when it is known. */
export function currentWebhookUrl(service) {
  return service.status().webhookUrl;
}


function prefixOf(value) {
  return value || '/';
}

export { WS_PATH };
