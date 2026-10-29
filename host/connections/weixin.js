/** iLink lifecycle and receive loop. One instance owns one bot and its tokens. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WeixinAccountState } from '../weixin-state.js';
import { setTimeout as delay } from 'node:timers/promises';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import QRCode from 'qrcode';
import { weixinAttachments } from '../weixin-media.js';
import { createWeixinApi, extractWeixinText, extractWeixinReplyReference, normalizeWeixinApiBaseUrl, orderWeixinMessages, rejectedProviderResponse, weixinMessageId } from '../weixin-api.js';

export class WeixinConnection {
  id = 'weixin';
  label = '微信机器人';
  capabilities = { typing: true, media: true, groupMention: false, nativeReply: false };
  #config; #api; #file; #account = null; #handlers; #run; #loop; #login;
  #phase = 'idle'; #error = ''; #accountState = null; #seen = new Set(); #buffer = '';
  #fetchImpl;
  #stopped = true;
  #received = 0;
  #lastInbound = null;
  constructor({ config, api, accountFile, fetchImpl = fetch } = {}) {
    this.#config = config ?? {};
    this.#api = api ?? createWeixinApi({ fetchImpl });
    this.#fetchImpl = fetchImpl;
    this.#file = accountFile ?? join(this.#config.weixinAccountFile || dshHomePath('wechatpad', 'weixin-accounts'), 'credentials.json');
  }
  #state(phase, error = '') {
    this.#phase = phase; this.#error = error;
    this.#handlers?.onState?.({ phase, error });
  }
  async start(handlers) {
    this.#handlers = handlers; this.#stopped = false;
    try {
      const value = JSON.parse(await readFile(this.#file, 'utf8'));
      if (value?.token && value?.botId) {
        this.#account = { ...value, baseUrl: normalizeWeixinApiBaseUrl(value.baseUrl) };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.#state('error', '无法读取机器人账号，请检查账号目录'); return; }
    }
    if (!this.#account) { this.#state('unconfigured', '尚未扫码绑定'); return; }
    try { await this.#loadAccountState(); }
    catch { this.#state('error', '无法恢复机器人回复凭证，请检查账号状态目录'); return; }
    this.#startReceive();
  }
  async #loadAccountState() {
    this.#accountState = null; this.#seen.clear(); this.#buffer = '';
    const state = new WeixinAccountState(this.#account.botId, {directory:join(dirname(this.#file), 'state')});
    await state.load();
    if (await state.bindContextTokens(this.#account.token)) {
      // A new login cannot borrow tokens, cursors or dedupe state from old credentials.
      await state.remove(); await state.bindContextTokens(this.#account.token);
    }
    this.#accountState = state;
    this.#seen = new Set(state.snapshot().seenMessageIds);
    this.#buffer = state.getUpdatesBuf();
  }
  #startReceive() {
    if (this.#stopped || this.#run) return;
    const controller = new AbortController();
    this.#run = controller;
    this.#state('starting');
    this.#loop = this.#receive(controller).finally(() => { if (this.#run === controller) this.#run = null; });
  }
  async #receive(controller) {
    while (!controller.signal.aborted && this.#account) {
      try {
        const result = await this.#api.getUpdates({ ...this.#account, getUpdatesBuf: this.#buffer, signal: controller.signal });
        if (controller.signal.aborted) return;
        const rejected = rejectedProviderResponse(result);
        if (rejected) {
          this.#state('error', rejected === '-14' ? '登录已失效，请重新扫码' : `微信接收失败（${rejected}）`);
          if (rejected === '-14') return;
          await delay(3000, undefined, { signal: controller.signal }); continue;
        }
        this.#state('connected');
        for (const message of orderWeixinMessages(result.msgs ?? [])) {
          if (controller.signal.aborted) return;
          const chatId = message.from_user_id;
          this.#received += 1;
          this.#lastInbound = { senderId: typeof chatId === 'string' ? chatId : '', messageType: message.message_type ?? null, hasText: Boolean(extractWeixinText(message)), at: Date.now() };
          if (!chatId || message.message_type !== 1) continue;
          const messageId = weixinMessageId(message);
          if (message.context_token) {
            await this.#accountState.rememberContextToken({userId:chatId,contextToken:message.context_token,seq:message.seq,messageTimeMs:message.create_time_ms});
          }
          if (messageId && this.#seen.has(messageId)) continue;
          const attachments = weixinAttachments(message, { fetchImpl: this.#fetchImpl });
          const text = extractWeixinText(message) || (attachments.length ? '' : null);
          if (text === null) continue;
          const replyTo = this.#config.weixinReplyQuote !== false ? extractWeixinReplyReference(message) : null;
          await this.#handlers?.onMessage?.({
            messageId, chatId, senderId: chatId, isGroup: false, mentioned: false,
            text: replyTo?.content ? `引用：${replyTo.content}\n\n${text}` : text,
            attachments, msgType: 1, createdAt: Number(message.create_time_ms) || Date.now(), ...(replyTo ? { replyTo } : {}),
          });
          if (messageId) { this.#seen.add(messageId); await this.#accountState.markSeen(messageId); }
          if (this.#seen.size > 1000) this.#seen.delete(this.#seen.values().next().value);
        }
        this.#buffer = result.get_updates_buf ?? this.#buffer;
        await this.#accountState.setGetUpdatesBuf(this.#buffer);
        // Some upstream responses return immediately with an empty batch.
        await delay(100, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        this.#state('error', error.message || '微信接收失败');
        try { await delay(3000, undefined, { signal: controller.signal }); } catch { return; }
      }
    }
  }
  async #stopReceive() {
    this.#run?.abort();
    await this.#loop;
    this.#run = null; this.#loop = null;
  }
  async stop() {
    this.#stopped = true;
    await this.cancelLogin(this.#login?.ticket);
    await this.#stopReceive();
    this.#state('stopped');
  }
  status() {
    return { provider: this.id, connected: this.#phase === 'connected', phase: this.#phase,
      messagesReceived: this.#received, lastInbound: this.#lastInbound,
      hasReplyContexts: this.#accountState?.status().hasContextTokens === 'yes',
      lastError: this.#error, botId: this.#account?.botId ?? '', boundAt: this.#account?.boundAt ?? '',
      capabilities: this.capabilities };
  }
  async send({ chatId, text, runId }) {
    if (!this.#account || this.#stopped) return { ok: false, delivered: 0, error: '机器人尚未连接' };
    const contextToken = this.#accountState?.contextTokenFor(chatId);
    if (!contextToken) return { ok: false, delivered: 0, error: '缺少回复凭证，请先在微信发送一条消息' };
    try {
      const result = await this.#api.sendText({ ...this.#account, toUserId: chatId, text, contextToken, runId, signal: this.#run?.signal });
      return { ok: true, delivered: 1, messageId: result.messageId };
    } catch (error) { return { ok: false, delivered: 0, error: error.message }; }
  }
  async sendFile({ chatId, file, runId, signal }) {
    if (!this.#account || this.#stopped) return { ok: false, delivered: 0, error: '机器人尚未连接' };
    const contextToken = this.#accountState?.contextTokenFor(chatId);
    if (!contextToken) return { ok: false, delivered: 0, error: '缺少回复凭证，请先在微信发送消息' };
    try {
      const method = file.mediaType?.startsWith('image/') ? 'sendImage' : 'sendFile';
      const result = await this.#api[method]({ ...this.#account, toUserId: chatId, file, contextToken, runId, signal: signal && this.#run ? AbortSignal.any([signal, this.#run.signal]) : signal ?? this.#run?.signal });
      return { ok: true, delivered: 1, messageId: result.messageId };
    } catch(error) { return { ok: false, delivered: 0, error: error.message }; }
  }
  async typing(chatId, on) {
    if (!this.#account || this.#stopped || this.#config.weixinTyping === false) return false;
    try {
      const args = { ...this.#account, toUserId: chatId, contextToken: this.#accountState?.contextTokenFor(chatId), signal: this.#run?.signal };
      const { typingTicket } = await this.#api.getConfig(args);
      if (!typingTicket) return false;
      await this.#api.sendTyping({ ...args, typingTicket, status: on ? 1 : 2 }); return true;
    } catch { return false; }
  }
  async test() {
    if (!this.#account) return { ok: false, error: '尚未扫码绑定', detail: '请先扫码' };
    // Do not start a second getUpdates consumer for a connection test.
    try { await this.#api.notifyStart({ ...this.#account, signal: this.#run?.signal }); return { ok: true, detail: '微信机器人可访问' }; }
    catch (error) { return { ok: false, error: error.message }; }
  }
  async beginLogin({ botType, verifyCode } = {}) {
    const previous = this.#login;
    const qr = verifyCode && previous ? previous : null;
    await this.cancelLogin(previous?.ticket);
    const controller = new AbortController();
    // Register cancellation before the first network call so teardown also
    // cancels a slow QR request that has not returned a ticket yet.
    const login = { ticket: randomUUID(), controller, state: 'wait', verifyCode, polling: null, expiresAt: Date.now() + 10 * 60_000 };
    this.#login = login;
    try {
      Object.assign(login, qr ? { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl } : await this.#api.beginLogin({ botType: botType ?? this.#config.weixinBotType, signal: controller.signal }));
      controller.signal.throwIfAborted();
      login.qrcodeImage = await QRCode.toDataURL(login.qrcodeUrl, { width: 240, margin: 2 });
      return this.#loginResult(login);
    } catch (error) { if (this.#login === login) this.#login = null; throw error; }
  }
  #loginResult(login) {
    return { supported: true, ticket: login.ticket, state: login.state, qrcodeUrl: login.qrcodeUrl, qrcodeImage: login.qrcodeImage };
  }
  async pollLogin(ticket) {
    const login = this.#login;
    if (!login || login.ticket !== ticket) throw new Error('二维码已取消，请重新生成');
    if (Date.now() >= login.expiresAt) { login.state = 'expired'; login.controller.abort(); }
    if (['confirmed', 'expired', 'verify_code_blocked'].includes(login.state)) return this.#loginResult(login);
    // UI polls can overlap while the upstream long poll is pending. Share it.
    if (!login.polling) login.polling = this.#poll(login).finally(() => { login.polling = null; });
    return login.polling;
  }
  async #poll(login) {
    const result = await this.#api.pollLogin({ qrcode: login.qrcode, baseUrl: login.baseUrl, verifyCode: login.verifyCode, signal: login.controller.signal });
    login.controller.signal.throwIfAborted();
    if (this.#login !== login || this.#stopped) throw new Error('二维码已取消');
    login.state = result.status;
    const redirect = result.redirect_host ?? result.redirect_uri;
    if (redirect) login.baseUrl = normalizeWeixinApiBaseUrl(redirect.includes('://') ? redirect : `https://${redirect}`);
    if (result.status === 'binded_redirect') {
      if (!this.#account) throw new Error('该账号已绑定，但本机没有可恢复的凭据，请重新生成二维码');
      login.state = 'confirmed'; this.#startReceive();
    }
    if (result.status === 'confirmed') {
      const token = result.bot_token; const botId = result.ilink_bot_id;
      if (!token || !botId) throw new Error('微信绑定响应缺少账号信息');
      const account = { token, botId, baseUrl: normalizeWeixinApiBaseUrl(result.baseurl || login.baseUrl || 'https://ilinkai.weixin.qq.com/'), boundAt: Date.now() };
      await this.#stopReceive();
      login.controller.signal.throwIfAborted();
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
      const temp = `${this.#file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(account), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.#file);
      this.#account = account; await this.#loadAccountState();
      login.state = 'confirmed'; this.#startReceive();
    }
    return this.#loginResult(login);
  }
  async cancelLogin(ticket) {
    const login = this.#login;
    if (login && (!ticket || login.ticket === ticket)) {
      this.#login = null; login.controller.abort();
      await login.polling?.catch(() => {});
    }
    return { supported: true, cancelled: true };
  }
  async resetAccount() {
    await this.cancelLogin(); await this.#stopReceive();
    // Preserve the file as an empty account rather than deleting other data.
    if (this.#account) await writeFile(this.#file, '{}', { mode: 0o600 });
    await this.#accountState?.remove(); this.#accountState = null;
    this.#account = null; this.#buffer = ''; this.#seen.clear();
    this.#state('unconfigured', '尚未扫码绑定'); return { supported: true, reset: true };
  }
}
export const createWeixinConnection = (options) => new WeixinConnection(options);
