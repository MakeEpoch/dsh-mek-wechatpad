/**
 * The WechatPad connection: the plugin's original protocol, unchanged.
 *
 * It owns everything that is specific to Pad / WeChat Bridge:
 *  - the three receive modes (`websocket` behind dsh's own proxy route,
 *    `webhook` with the callback registered on the Pad, and `bridge` which
 *    subscribes to the Bridge's `/ws/outbound` feed);
 *  - the self-identity facts the Pad needs to decode a message (its wxid and
 *    group nickname), including learning the nickname from the Bridge;
 *  - outbound delivery through `OutboundSender` -> `WechatPadClient`.
 *
 * Decoding, chunking and policy stay in `inbound.js` / `outbound.js`; this file
 * only wires them to the `WechatConnection` contract (see `types.js`).
 */
import { createRequire } from 'node:module';
import { padAttachments, isPendingPadFile } from '../pad-media.js';
import { encodeVoice } from '../voice.js';

import { bridgeAccounts, buildBridgeWsUrl, unwrapBridgeFrame } from '../bridge.js';
import { firstAccount, outboundTarget } from '../config.js';
import { decodeMessage } from '../inbound.js';
import { OutboundSender } from '../outbound.js';
import { WechatPadClient } from '../pad-api.js';
import { PushTransport, parseFrame } from '../transport.js';
import { registerPushRoute, registerWebhookRoute } from '../ws-route.js';
import { DEFAULT_CAPABILITIES, unsupportedFeature } from './types.js';

/** How long a Bridge nickname lookup may take before the Pad starts anyway. */
const NICKNAME_TIMEOUT_MS = 8_000;

export class PadConnection {
  /** @type {'pad'} */
  id = 'pad';
  label = 'WechatPad';

  /** Pad / Bridge can receive and send attachments through the Pad API. */
  capabilities = { ...DEFAULT_CAPABILITIES, media: true };

  #ctx;
  #config;
  #logger;
  #handlers = null;
  #client = null;
  #sender = null;
  #transport = null;
  #disposers = [];
  #webhookToken;
  #webhookUrl = '';
  #stopped = true;
  #lastError = '';

  /**
   * @param {object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx
   * @param {ReturnType<import('../config.js').resolveConfig>} options.config resolved Config.
   * @param {(level: string, msg: string) => void} [options.logger]
   * @param {string} [options.webhookToken] token the Pad must present on the webhook.
   */
  constructor({ ctx, config, logger, webhookToken }) {
    this.#ctx = ctx;
    this.#config = config;
    this.#logger = logger ?? (() => {});
    this.#webhookToken = webhookToken ?? '';
  }

  /** The absolute webhook URL, once this connection has published it. */
  get webhookUrl() {
    return this.#webhookUrl;
  }

  /** Whether outbound calls have enough configuration to reach the Pad. */
  get configured() {
    return Boolean(outboundTarget(this.#config).configured);
  }

  /** @param {import('./types.js').ConnectionHandlers} handlers */
  async start(handlers) {
    this.#handlers = { ...handlers };
    this.#stopped = false;
    const config = this.#config;
    this.#buildRuntimes();
    this.#registerRoutes();
    this.#transport = this.#newTransport();
    if (config.receiveMode === 'webhook') {
      // `#registerRoutes` already kicked off an unawaited registration; this
      // second, awaited one is what reports its result before start() returns.
      await this.#registerWebhookOnPad();
      return;
    }
    if (config.receiveMode === 'bridge') {
      // Only the Bridge can name the account it serves, so the lookup stays
      // scoped to bridge mode exactly as it was before the extraction.
      await this.#loadSelfIdentity();
      await this.#startBridgeSubscription();
      return;
    }
    try {
      await this.#transport?.start();
    } catch (error) {
      this.#emitState({ phase: 'error', error: String(error?.message ?? error) });
    }
  }

  async stop() {
    this.#stopped = true;
    for (const dispose of this.#disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        this.#logger('debug', `释放微信路由失败：${error?.message ?? error}`);
      }
    }
    this.#disposers = [];
    if (this.#transport) {
      this.#transport.stop();
      this.#transport = null;
    }
    const client = this.#client;
    if (client && this.#config.receiveMode === 'webhook' && this.#webhookUrl) {
      await client.setCallback('', false).catch(() => {});
    }
    this.#webhookUrl = '';
    this.#sender = null;
    this.#client = null;
    this.#handlers = null;
  }

  /**
   * Deliver one plain-text message.
   * @param {import('./types.js').SendRequest} request
   * @returns {Promise<import('./types.js').SendResult>}
   */
  async send(request) {
    const sender = this.#sender;
    if (!sender) return { ok: false, delivered: 0, error: 'WechatPad 连接尚未就绪' };
    const result = await sender.sendText(request.chatId, request.text);
    return {
      ok: Boolean(result?.ok),
      delivered: result?.ok ? 1 : 0,
      ...(result?.ok ? {} : { error: String(result?.error ?? '未知原因') }),
      ...(result?.messageId ? { messageId: String(result.messageId) } : {}),
    };
  }

  async sendFile({ chatId, file, signal }) {
    if (!this.#sender || this.#stopped) return { ok: false, delivered: 0, error: 'Pad 连接尚未就绪' };
    try {
      const result = await this.#sender.sendMedia(chatId, async () => {
        if (file.mediaType?.startsWith('image/')) return this.#client.sendImage(chatId, file.bytes.toString('base64'), { signal });
        if (file.mediaType?.startsWith('audio/')) {
          const voice = await encodeVoice(file.bytes, { signal });
          if (voice.seconds <= 60) return this.#client.sendVoice(chatId, voice, { signal });
          // Longer recordings retain their full content as an audio file.
        }
        return this.#client.sendFile(chatId, file, { signal });
      });
      return { ...result, delivered: result.ok ? 1 : 0 };
    } catch (error) { return { ok: false, delivered: 0, error: error.message }; }
  }

  /**
   * The Pad has no "is typing" channel: WeChat offers one to the mobile client
   * only. Declared explicitly so callers never have to guess.
   * @returns {Promise<boolean>} always false.
   */
  async typing() {
    return false;
  }

  /**
   * The Pad binds an account by being scanned itself, so the plugin never runs
   * a login sequence: these four answer "unsupported" for the settings page.
   */
  async beginLogin() {
    return unsupportedFeature('WechatPad 通过 Pad 本身登录，不支持扫码绑定');
  }

  async pollLogin() {
    return unsupportedFeature('WechatPad 通过 Pad 本身登录，不支持扫码绑定');
  }

  async cancelLogin() {
    return unsupportedFeature('WechatPad 通过 Pad 本身登录，不支持扫码绑定');
  }

  async resetAccount() {
    return unsupportedFeature('WechatPad 的账号由 Pad 管理，无法在此重置');
  }

  /** @returns {import('./types.js').ConnectionStatus} */
  status() {
    const target = outboundTarget(this.#config);
    return {
      provider: this.id,
      connected: this.#transport?.connected ?? false,
      lastError: this.#lastError,
      receiveMode: this.#config.receiveMode,
      configured: target.configured,
      baseUrl: this.#config.apiPrefix ? target.baseUrl : this.#config.baseUrl,
      webhookUrl: this.#webhookUrl,
      receiveModes: ['websocket', 'webhook', 'bridge'],
      capabilities: { ...this.capabilities },
    };
  }

  /**
   * Probe the Pad without touching runtime state.
   * @returns {Promise<import('./types.js').ProbeResult>}
   */
  async test() {
    const target = outboundTarget(this.#config);
    if (!target.configured) {
      return {
        ok: false,
        error: this.#config.receiveMode === 'bridge' ? '需要 Bridge 地址和机器人 wxid' : '尚未填写地址或 key',
        detail: '配置不完整',
      };
    }
    const client = new WechatPadClient({
      baseUrl: target.baseUrl,
      key: target.key,
      apiPrefix: target.apiPrefix,
      wxid: target.wxid,
      timeoutMs: Math.min(15_000, this.#config.requestTimeoutSeconds * 1000),
    });
    const status = await client.loginStatus();
    return {
      ok: status.ok,
      error: status.error,
      detail: status.ok ? 'WechatPad 可访问，key 有效' : 'WechatPad 不可访问或 key 无效',
      extra: { receiveMode: this.#config.receiveMode, webhookUrl: this.#webhookUrl },
    };
  }

  // ── 装配 ──────────────────────────────────────────────────────────────────

  #buildRuntimes() {
    const config = this.#config;
    // Outbound always speaks the Pad protocol, but in bridge mode it goes
    // through the Bridge's /proxy path and needs no Pad address or key.
    const target = outboundTarget(config);
    this.#client = new WechatPadClient({
      baseUrl: target.baseUrl,
      key: target.key,
      apiPrefix: target.apiPrefix,
      wxid: target.wxid,
      timeoutMs: config.requestTimeoutSeconds * 1000,
      logger: this.#logger,
    });
    this.#sender = new OutboundSender({ client: this.#client, logger: this.#logger });
  }

  #registerRoutes() {
    this.#disposers.push(registerPushRoute({
      ctx: this.#ctx,
      padTarget: () => this.#pushTarget(),
      onFrame: (frame) => this.#handleFrame(frame),
      logger: this.#logger,
    }));
    this.#disposers.push(registerWebhookRoute({
      ctx: this.#ctx,
      path: this.#config.webhookPath,
      webhookAuth: () => ({ token: this.#webhookToken }),
      onPayload: (payload) => this.#handleInbound(payload),
      logger: this.#logger,
    }));
    void this.#registerWebhookOnPad();
  }

  #pushTarget() {
    if (!this.#client?.configured) return null;
    const origin = this.#config.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
    return { url: `${origin}/ws/GetSyncMsg?key=${encodeURIComponent(this.#config.key)}`, key: this.#config.key };
  }

  /** The bot's own identity, used to recognise group mentions and self-echo. */
  #identity() {
    return {
      selfWxid: this.#config.selfWxid || this.#config.wxid,
      selfNickname: this.#config.selfNickname,
    };
  }

  #newTransport() {
    if (this.#config.receiveMode === 'bridge') {
      const config = this.#config;
      const accounts = bridgeAccounts({ ...config, bridgeAccounts: config.bridgeAccounts || config.wxid });
      if (!config.bridgeBaseUrl || !config.bridgeToken) {
        this.#emitState({ phase: 'error', missing: 'Bridge 地址或 token', error: '接收方式为 bridge，但缺少 Bridge 地址或 token' });
        return null;
      }
      if (accounts.length === 0) {
        this.#emitState({ phase: 'error', missing: '机器人 wxid', error: 'bridge 模式需要填写机器人 wxid（订阅账号）' });
        return null;
      }
      let url;
      try {
        url = buildBridgeWsUrl({
          baseUrl: config.bridgeBaseUrl,
          token: config.bridgeToken,
          accounts,
          clientId: config.bridgeClientId,
        });
      } catch (error) {
        this.#emitState({ phase: 'error', error: String(error?.message ?? error) });
        return null;
      }
      return new PushTransport({
        url: config.bridgeBaseUrl,
        open: async () => openSocket(url),
        onFrame: (raw) => this.#handleBridgeFrame(raw),
        logger: this.#logger,
        onState: (state, detail) => this.#emitTransportState(state, detail, 'Bridge 订阅'),
      });
    }
    return new PushTransport({
      url: this.#config.baseUrl,
      open: async () => {
        const target = this.#pushTarget();
        if (!target) throw new Error('WechatPad 未配置');
        return openSocket(target.url);
      },
      onFrame: (raw) => this.#handleFrame(raw),
      logger: this.#logger,
      onState: (state, detail) => this.#emitTransportState(state, detail, '微信推送连接'),
    });
  }

  #emitTransportState(state, detail, what) {
    if (this.#stopped) return;
    if (state === 'open') this.#emitState({ phase: 'connected' });
    else if (state === 'error') this.#emitState({ phase: 'error', error: `${what}失败：${detail ?? ''}` });
    else this.#emitState({ phase: 'reconnecting', label: `${what}已断开，正在重连…` });
  }

  #emitState(update) {
    if (update.phase === 'error') this.#lastError = String(update.error ?? '');
    else if (update.phase === 'connected') this.#lastError = '';
    try {
      this.#handlers?.onState?.(update);
    } catch (error) {
      this.#logger('warn', `连接状态回调失败：${error?.message ?? error}`);
    }
  }

  #emitMessage(message) {
    // Do not admit the upload notification or consume its dedupe id. The
    // completed file arrives next with that same id and contains the CDN data.
    if (message.mediaPayload && isPendingPadFile(message.mediaPayload)) return;
    if (message.mediaPayload) message.attachments = padAttachments(message.mediaPayload, this.#client);
    try {
      return this.#handlers?.onMessage?.(message);
    } catch (error) {
      this.#logger('error', `微信消息回调失败：${error?.message ?? error}`);
      return undefined;
    }
  }

  /**
   * Learn the bot's nickname when the config does not name one.
   *
   * A group mention renders the bot's NICKNAME, not its wxid, so without this
   * the mention check cannot match and `groupRequireMention` would silently drop
   * every group message. The Bridge already knows the account it serves, so it
   * is asked once at startup instead of making the operator copy the name.
   */
  async #loadSelfIdentity() {
    if (this.#config.selfNickname) return;
    const wxid = this.#config.wxid || firstAccount(this.#config.bridgeAccounts) || this.#config.selfWxid;
    const base = this.#config.bridgeBaseUrl;
    if (!base || !wxid) return;
    try {
      const response = await fetch(`${base.replace(/\/+$/, '')}/bridge/accounts`, {
        signal: AbortSignal.timeout(NICKNAME_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const body = await response.json();
      const row = (Array.isArray(body?.accounts) ? body.accounts : []).find((item) => item?.wxid === wxid);
      const nickname = String(row?.nick_name ?? '').trim();
      if (nickname) {
        this.#config.selfNickname = nickname;
        this.#logger('info', `群聊 @ 检测使用机器人昵称「${nickname}」`);
      }
    } catch (error) {
      this.#logger('debug', `未能从 Bridge 读取机器人昵称：${error?.message ?? error}`);
    }
  }

  /**
   * Subscribe to a WeChat Bridge's outbound WebSocket.
   *
   * The Bridge fans every inbound message out to its webhook target AND every
   * `/ws/outbound` subscriber, so this seat sits beside the webhook the CMS API
   * already owns instead of taking it over. Each subscriber carries its own
   * `client_id`; using `dsh` keeps this plugin and the dashboard independent.
   */
  async #startBridgeSubscription() {
    const transport = this.#transport;
    if (!transport) return;
    const accounts = bridgeAccounts({ ...this.#config, bridgeAccounts: this.#config.bridgeAccounts || this.#config.wxid });
    try {
      await transport.start();
      this.#logger('info', `已订阅 WeChat Bridge ${this.#config.bridgeBaseUrl}（wxids=${accounts.join(',')}）`);
    } catch (error) {
      this.#emitState({ phase: 'error', error: String(error?.message ?? error) });
    }
  }

  async #registerWebhookOnPad() {
    const client = this.#client;
    if (this.#config.receiveMode !== 'webhook' || !client?.configured) return;
    let origin = '';
    try {
      origin = this.#ctx.webServer.getOrigin();
    } catch (error) {
      this.#emitState({ phase: 'error', error: `无法确定 dsh Web 地址：${error?.message ?? error}` });
      return;
    }
    this.#webhookUrl = `${origin}${this.#config.webhookPath}`;
    const result = await client.setCallback(this.#webhookUrl, true);
    if (!result.ok) {
      this.#emitState({ phase: 'error', error: `注册微信回调失败：${result.error}` });
      return;
    }
    this.#emitState({ phase: 'connected', label: '已注册回调，等待微信消息' });
  }

  // ── 接收 ──────────────────────────────────────────────────────────────────

  #handleFrame(raw) {
    const parsed = parseFrame(raw, this.#identity());
    if (parsed.kind === 'message') {
      this.#emitMessage(parsed.message);
      return;
    }
    if (parsed.kind === 'batch') {
      for (const message of parsed.messages) this.#emitMessage(message);
      return;
    }
    if (parsed.kind === 'status') {
      const ok = parsed.payload.Success ?? parsed.payload.ok ?? true;
      if (ok === false) {
        this.#emitState({
          phase: 'error',
          error: String(parsed.payload.Text ?? parsed.payload.Message ?? '微信返回失败'),
        });
      }
    }
  }

  /** Unwrap one Bridge frame and feed the normal inbound path. */
  #handleBridgeFrame(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = unwrapBridgeFrame(payload);
    if (!frame) return;
    if ('control' in frame) {
      if (frame.control === 'ping') this.#transport?.send('{"type":"pong"}');
      if (frame.control === 'error' || frame.control === 'warning') {
        this.#emitControl({ kind: frame.control, detail: String(frame.detail ?? '') });
      }
      return;
    }
    // The Bridge answers with the Bot's own wxid; remember it so self-echo
    // filtering works even when `selfWxid` was left empty.
    if (frame.wxid && !this.#config.selfWxid) this.#config.selfWxid = frame.wxid;
    if (frame.message) this.#handleInbound(frame.message);
  }

  #emitControl(event) {
    try {
      this.#handlers?.onControl?.(event);
    } catch (error) {
      this.#logger('warn', `连接控制回调失败：${error?.message ?? error}`);
    }
  }

  /** Decode one raw payload (webhook body or Bridge payload) and hand it up. */
  #handleInbound(payload) {
    const message = decodeMessage(payload, this.#identity());
    if (!message) return;
    return this.#emitMessage(message);
  }
}

/** Open one WebSocket with the `ws` package and resolve once it is up. */
async function openSocket(url) {
  const { WebSocket } = createRequire(import.meta.url)('ws');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/**
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {ReturnType<import('../config.js').resolveConfig>} options.config
 * @param {(level: string, msg: string) => void} [options.logger]
 * @param {string} [options.webhookToken]
 * @returns {import('./types.js').WechatConnection}
 */
export function createPadConnection(options) {
  return new PadConnection(options);
}
