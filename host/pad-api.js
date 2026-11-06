/** OneBot v12 HTTP client; all native service differences stay on the server. */
import { randomUUID } from 'node:crypto';

export const SEND_CHUNK_DELAY_MS = 1100;
export class WechatPadClient {
  #baseUrl; #token; #wxid; #timeoutMs; #logger;
  constructor({ baseUrl, token = '', wxid = '', timeoutMs = 20000, logger = () => {} }) {
    this.#baseUrl = String(baseUrl ?? '').replace(/\/+$/, ''); this.#token = token; this.#wxid = wxid; this.#timeoutMs = timeoutMs; this.#logger = logger;
  }
  get configured() { return Boolean(this.#baseUrl && this.#token && this.#wxid); }
  url() { return `${this.#baseUrl}/`; }
  async request(action, params = {}, { signal, timeoutMs = this.#timeoutMs } = {}) {
    if (!this.configured) return { ok: false, data: null, error: '请配置服务地址、Token 和机器人 wxid' };
    const echo = randomUUID();
    try {
      const response = await fetch(this.url(), {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.#token}` },
        body: JSON.stringify({ action, params, self: { platform: 'wechat', user_id: this.#wxid }, echo }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { ok: false, data: null, status: response.status, error: `OneBot HTTP ${response.status}` };
      const result = await response.json();
      if (result.echo !== echo || !['ok', 'failed'].includes(result.status) || !Number.isInteger(result.retcode) || !Object.hasOwn(result, 'data') || typeof result.message !== 'string') return { ok: false, data: null, error: '无效的 OneBot 动作响应' };
      if (result.status !== 'ok' || result.retcode !== 0) return { ok: false, data: result.data, retcode: result.retcode, error: String(result.message || `OneBot retcode=${result.retcode}`), source: result['wechat.source'] };
      return { ok: true, data: result.data, source: result['wechat.source'] };
    } catch (error) { this.#logger('debug', `OneBot ${action} failed`); return { ok: false, data: null, error: error.message || String(error) }; }
  }
  async sendText(to, text, { atWxIdList = [] } = {}) {
    return this.#send(to, [...atWxIdList.map(user_id => ({ type: 'mention', data: { user_id } })), { type: 'text', data: { text } }]);
  }
  async #send(to, message, options) {
    const target = to.endsWith('@chatroom') ? { detail_type: 'group', group_id: to } : { detail_type: 'private', user_id: to };
    // An uncertain send is never automatically retried: echo correlates, it does not deduplicate.
    const result = await this.request('send_message', { ...target, message }, options);
    return { ...result, messageId: result.ok ? String(result.data?.message_id ?? '') : undefined };
  }
  async #media(to, type, name, bytes, extra, options) {
    const upload = await this.request('upload_file', { type: 'data', name, data: bytes.toString('base64') }, options);
    if (!upload.ok || !upload.data?.file_id) return { ...upload, ok: false, error: upload.error || '上传未返回 file_id' };
    return this.#send(to, [{ type, data: { file_id: upload.data.file_id, ...extra } }], options);
  }
  sendImage(to, base64, options) { return this.#media(to, 'image', 'image.png', Buffer.from(base64, 'base64'), {}, options); }
  sendFile(to, file, options) { return this.#media(to, 'file', file.fileName, file.bytes, {}, options); }
  sendVoice(to, voice, options) { return this.#media(to, 'voice', 'voice.silk', voice.bytes, { 'wechat.duration': voice.seconds }, options); }
  async loginStatus() {
    const response = await this.request('get_status', {});
    if (!response.ok) return response;
    const bot = response.data?.bots?.find(item => item.self?.platform === 'wechat' && item.self?.user_id === this.#wxid);
    return bot?.online ? response : { ok: false, data: response.data, error: '机器人离线或账号不存在' };
  }
  loginUserInfo() { return this.request('get_self_info', {}); }
}

/** Reply chunks keep their existing spacing independent from transport. */
export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
