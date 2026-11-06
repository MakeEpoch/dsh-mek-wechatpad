/** WechatPad: one WS receive path and authenticated HTTP sends. */
import { createRequire } from 'node:module';
import { isPendingPadFile } from '../pad-media.js';
import { encodeVoice } from '../voice.js';

import { buildPadWsUrl, unwrapPadFrame } from '../pad-feed.js';
import { outboundTarget } from '../config.js';
import { decodeOneBot } from '../onebot-message.js';
import { OutboundSender } from '../outbound.js';
import { WechatPadClient } from '../pad-api.js';
import { PushTransport } from '../transport.js';
import { DEFAULT_CAPABILITIES, unsupportedFeature } from './types.js';

export class PadConnection {
  /** @type {'pad'} */
  id = 'pad';
  label = 'WechatPad';

  /** Pad can receive and send attachments through the Pad API. */
  capabilities = { ...DEFAULT_CAPABILITIES, media: true };

  #config;
  #logger;
  #handlers = null;
  #client = null;
  #sender = null;
  #transport = null;
  #stopped = true;
  #lastError = '';

  /**
   * @param {object} options
   * @param {ReturnType<import('../config.js').resolveConfig>} options.config resolved Config.
   * @param {(level: string, msg: string) => void} [options.logger]
   */
  constructor({ config, logger }) {
    this.#config = config;
    this.#logger = logger ?? (() => {});
  }

  /** Whether outbound calls have enough configuration to reach the Pad. */
  get configured() {
    return Boolean(outboundTarget(this.#config).configured);
  }

  /** @param {import('./types.js').ConnectionHandlers} handlers */
  async start(handlers) {
    this.#handlers = { ...handlers };
    this.#stopped = false;
    this.#buildRuntimes();
    this.#transport = this.#newTransport();
    await this.#loadSelfIdentity();
    try {
      await this.#transport?.start();
    } catch (error) {
      this.#emitState({ phase: 'error', error: String(error?.message ?? error) });
    }
  }

  async stop() {
    this.#stopped = true;
    this.#transport?.stop();
    this.#transport = null;
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
      receiveMode: 'websocket',
      configured: target.configured,
      baseUrl: target.baseUrl,
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
        error: '需要服务地址、访问 Token 和机器人 wxid',
        detail: '配置不完整',
      };
    }
    const client = new WechatPadClient({
      baseUrl: target.baseUrl,
      token: target.token,
      wxid: target.wxid,
      timeoutMs: Math.min(15_000, this.#config.requestTimeoutSeconds * 1000),
    });
    const status = await client.loginStatus();
    return {
      ok: status.ok,
      error: status.error,
      detail: status.ok ? 'WechatPad 可访问，账号已登录' : 'WechatPad 不可访问或账号未登录',
      extra: { receiveMode: 'websocket' },
    };
  }

  // ── 装配 ──────────────────────────────────────────────────────────────────

  #buildRuntimes() {
    const config = this.#config;
    const target = outboundTarget(config);
    this.#client = new WechatPadClient({
      baseUrl: target.baseUrl,
      token: target.token,
      wxid: target.wxid,
      timeoutMs: config.requestTimeoutSeconds * 1000,
      logger: this.#logger,
    });
    this.#sender = new OutboundSender({ client: this.#client, logger: this.#logger });
  }

  #newTransport() {
    const config = this.#config;
    if (!outboundTarget(config).configured) {
      this.#emitState({ phase: 'error', error: '需要服务地址、访问 Token 和机器人 wxid' });
      return null;
    }
    try {
      const url = buildPadWsUrl(config);
      return new PushTransport({
        url: config.baseUrl,
        open: async () => openSocket(url, config.token),
        onFrame: (raw) => this.#handlePadFrame(raw),
        logger: this.#logger,
        onState: (state, detail) => this.#emitTransportState(state, detail, 'WechatPad WS'),
      });
    } catch (error) {
      this.#emitState({ phase: 'error', error: String(error?.message ?? error) });
      return null;
    }
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
   * every group message. The server already knows the account it serves, so it
   * is asked once at startup instead of making the operator copy the name.
   */
  async #loadSelfIdentity() {
    if (this.#config.selfNickname) return;
    const wxid = this.#config.wxid;
    const base = this.#config.baseUrl;
    if (!base || !wxid) return;
    try {
      const response = await this.#client.loginUserInfo();
      if (!response.ok) return;
      const nickname = String(response.data?.user_name ?? '').trim();
      if (nickname) {
        this.#config.selfNickname = nickname;
        this.#logger('info', `群聊 @ 检测使用机器人昵称「${nickname}」`);
      }
    } catch (error) {
      this.#logger('debug', `未能从服务端读取机器人昵称：${error?.message ?? error}`);
    }
  }

  /** Unwrap one server frame and feed the normal inbound path. */
  #handlePadFrame(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = unwrapPadFrame(payload);
    if (!frame) return;
    if ('control' in frame) {
      if (frame.control === 'error' || frame.control === 'warning') {
        this.#emitControl({ kind: frame.control, detail: String(frame.detail ?? '') });
      }
      return;
    }
    if (frame.wxid !== this.#config.wxid) return;
    if (frame.message) this.#handleInbound(frame.message);
  }

  #emitControl(event) {
    try {
      this.#handlers?.onControl?.(event);
    } catch (error) {
      this.#logger('warn', `连接控制回调失败：${error?.message ?? error}`);
    }
  }

  /** Decode one raw payload (WS payload) and hand it up. */
  #handleInbound(payload) {
    const message = decodeOneBot(payload, this.#client);
    if (!message) return;
    return this.#emitMessage(message);
  }
}

/** Open one WebSocket with the `ws` package and resolve once it is up. */
async function openSocket(url, token) {
  const { WebSocket } = createRequire(import.meta.url)('ws');
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/**
 * @param {object} options
 * @param {ReturnType<import('../config.js').resolveConfig>} options.config
 * @param {(level: string, msg: string) => void} [options.logger]
 * @returns {import('./types.js').WechatConnection}
 */
export function createPadConnection(options) {
  return new PadConnection(options);
}
