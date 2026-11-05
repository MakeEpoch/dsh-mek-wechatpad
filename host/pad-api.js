/**
 * WechatPad HTTP client.
 *
 * wechatReal08 exposes Pad endpoints under `/proxy/{wxid}/...`.
 * WechatPad answers every endpoint with `{ Code, Success, Data, Message }`
 * where `Data` nests the real payload; gateway errors may use `{ ok, ... }`.
 * Both shapes are unwrapped here so callers only see `{ ok, data, error }`.
 */
import { extname } from 'node:path';

const RETRYABLE_MARKERS = [
  'timeout', 'timed out', 'temporary', 'temporarily', 'try again', 'server error',
  'internal error', 'connection reset', 'connection refused', 'connection closed',
  'network', 'econnreset', 'econnrefused', 'etimedout', '502', '503', '504', '429',
  'too many requests', 'unavailable', 'gateway',
];
const BENIGN_MARKERS = ['already exists', 'duplicate', 'no change'];

/** Send retry backoff schedule in milliseconds. */
const SEND_RETRY_DELAYS = [1000, 2000];
/** WeChat de-duplicates messages sharing one createTime second, so chunk sends are spaced. */
export const SEND_CHUNK_DELAY_MS = 1100;

export class WechatPadClient {
  #baseUrl;
  #token;
  #wxid;
  #timeoutMs;
  #logger;

  /**
   * @param {object} options client options.
   * @param {string} options.baseUrl service origin without a trailing slash.
   * @param {string} options.token service access token.
   * @param {string} options.wxid logged-in bot wxid.
   * @param {number} [options.timeoutMs] per-request timeout.
   * @param {(level: string, msg: string, extra?: unknown) => void} [options.logger]
   */
  constructor({ baseUrl, token = '', wxid = '', timeoutMs = 20000, logger = () => {} }) {
    this.#baseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
    this.#token = String(token).trim();
    this.#wxid = String(wxid ?? '').trim();
    this.#timeoutMs = timeoutMs;
    this.#logger = logger;
  }

  get configured() {
    return Boolean(this.#baseUrl && this.#token && this.#wxid);
  }

  /** Absolute URL of one Pad endpoint, scoped to the configured account. */
  url(path) {
    const endpoint = path.startsWith('/') ? path : `/${path}`;
    return `${this.#baseUrl}/proxy/${encodeURIComponent(this.#wxid)}${endpoint}`;
  }

  /**
   * Call one endpoint and normalize its envelope.
   * @param {string} method HTTP method.
   * @param {string} path Pad endpoint such as `/message/SendTextMessage`.
   * @param {object} [payload] JSON request body.
   * @param {{ retries?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ ok: boolean, data: unknown, error?: string, status?: number }>}
   */
  async request(method, path, payload, options = {}) {
    if (!this.configured) {
      return { ok: false, data: null, error: '未配置 WechatPad 地址、访问 Token 或机器人 wxid' };
    }
    const retries = Number.isInteger(options.retries) ? options.retries : SEND_RETRY_DELAYS.length;
    let attempt = 0;
    let last = { ok: false, data: null, error: 'request did not run' };
    while (attempt <= retries) {
      last = await this.#attempt(method, path, payload, options.signal, options.timeoutMs);
      if (last.ok) return last;
      const retryable = isRetryable(last.error);
      if (!retryable || attempt >= retries) return last;
      await sleep(SEND_RETRY_DELAYS[Math.min(attempt, SEND_RETRY_DELAYS.length - 1)]);
      attempt += 1;
    }
    return last;
  }

  /** Send one text message; returns the server receipt when it provides one. */
  async sendText(toUserName, text, { atWxIdList } = {}) {
    const item = { ToUserName: toUserName, MsgType: 1, TextContent: text };
    if (Array.isArray(atWxIdList) && atWxIdList.length > 0) item.AtWxIDList = atWxIdList;
    const result = await this.request('POST', '/message/SendTextMessage', { MsgItem: [item] });
    return { ...result, messageId: extractMessageId(result.data) };
  }

  /** Send one image from base64 bytes. */
  async sendImage(toUserName, imageBase64, { signal } = {}) {
    const item = { ToUserName: toUserName, MsgType: 2, ImageContent: imageBase64 };
    const result = await this.request('POST', '/message/SendImageNewMessage', { MsgItem: [item] }, { retries: 0, signal });
    return { ...result, messageId: extractMessageId(result.data) };
  }

  /** Upload the attachment, then send its type-6 App message. */
  async sendFile(toUserName, file, { signal } = {}) {
    const upload = await this.request('POST', '/other/UploadAppAttach', { fileData: file.bytes.toString('base64') }, { retries: 0, signal, timeoutMs: 120_000 });
    if (!upload.ok) return { ...upload, error: upload.status === 404 ? '当前 Pad 服务未提供文件上传接口 UploadAppAttach' : `文件上传失败：${upload.error}` };
    const rawId = upload.data?.mediaId ?? upload.data?.MediaId;
    const mediaId = typeof rawId === 'string' ? rawId : rawId?.str;
    if (typeof mediaId !== 'string' || !mediaId.trim()) return { ok: false, data: null, error: '文件上传未返回 mediaId，未发送文件消息' };
    const length = Number(upload.data?.totalLen ?? file.bytes.length);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, data: null, error: '文件上传返回无效长度，未发送文件消息' };
    const result = await this.request('POST', '/message/SendAppMessage', { AppList: [{ ToUserName: toUserName, ContentType: 6, ContentXML: fileAppMessageXml(file.fileName, length, mediaId) }] }, { retries: 0, signal, timeoutMs: 30_000 });
    return { ...result, messageId: extractMessageId(result.data) };
  }
  async sendVoice(toUserName, voice, { signal } = {}) {
    const result = await this.request('POST', '/message/SendVoice', { ToUserName: toUserName, VoiceData: voice.bytes.toString('base64'), VoiceFormat: 4, VoiceSecond: voice.seconds }, { retries: 0, signal });
    return { ...result, messageId: extractMessageId(result.data) };
  }

  /** Current login state. `Success`/`Code` is reported without parsing a user id. */
  async loginStatus() {
    const result = await this.request('GET', '/login/GetLoginStatus', undefined, { retries: 1 });
    return result;
  }

  /** Registered account contacts, used to derive the bot's own nick name. */
  async loginUserInfo() {
    const result = await this.request('GET', '/login/GetProfile', undefined, { retries: 0 });
    return result;
  }

  async #attempt(method, path, payload, signal, timeoutMs = this.#timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('WechatPad request timed out')), timeoutMs);
    const composite = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const url = this.url(path);
    const query = new URL(url);
    try {
      const response = await fetch(query, {
        method,
        headers: {
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          'X-Bridge-Token': this.#token,
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: composite,
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        return { ok: false, data: parsed, error: `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`, status: response.status };
      }
      return normalizeEnvelope(parsed);
    } catch (error) {
      const message = describeNetworkError(error, timeoutMs);
      this.#logger('debug', `WechatPad ${method} ${path} failed: ${message}`);
      return { ok: false, data: null, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

function fileAppMessageXml(name, size, mediaId) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[char]);
  const extension = extname(name).slice(1).toLowerCase() || 'bin';
  return `<appmsg appid="wx6618f1cfc6c132f8" sdkver=""><title>${escape(name)}</title><des></des><action></action><type>6</type><content></content><url></url><lowurl></lowurl><appattach><totallen>${size}</totallen><attachid>${escape(mediaId)}</attachid><fileext>${escape(extension)}</fileext></appattach><extinfo></extinfo></appmsg>`;
}

/**
 * Normalize a WechatPad JSON envelope.
 * @param {unknown} parsed decoded JSON body.
 * @returns {{ ok: boolean, data: unknown, error?: string }}
 */
export function normalizeEnvelope(parsed) {
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: true, data: parsed };
  }
  const envelope = /** @type {Record<string, any>} */ (parsed);
  if (envelope.ok === false) {
    return { ok: false, data: envelope, error: String(envelope.error ?? envelope.detail ?? 'WechatPad 返回失败') };
  }
  // Match Hermes: nested send receipts are authoritative, including failures
  // inside a Code=200 envelope. Scan all entries so success cannot mask failure.
  let sendSucceeded = false;
  for (const item of iterateDicts(envelope.Data ?? envelope)) {
    if (item.isSendSuccess === false) {
      return { ok: false, data: envelope.Data ?? envelope, error: String(item.errMsg || item.message || 'isSendSuccess=false') };
    }
    if (item.ret !== undefined && item.ret !== null && item.ret !== 0 && item.ret !== '0') {
      return { ok: false, data: envelope.Data ?? envelope, error: String(item.errMsg || `ret=${item.ret}`) };
    }
    if (item.retCode !== undefined && item.retCode !== null && item.retCode !== 0 && item.retCode !== '0') {
      return { ok: false, data: envelope.Data ?? envelope, error: String(item.errMsg || `retCode=${item.retCode}`) };
    }
    if (item.isSendSuccess === true || item.ret === 0 || item.ret === '0') sendSucceeded = true;
  }
  if (sendSucceeded) return { ok: true, data: envelope.Data ?? envelope };
  // Healthy login probes can report Code=200 with Success=false; absent a
  // nested send receipt, retain that endpoint's existing success semantics.
  if (typeof envelope.Code === 'number') {
    if (envelope.Code === 200) return { ok: true, data: envelope.Data ?? null };
    return { ok: false, data: envelope.Data ?? null, error: String(envelope.Text || envelope.Message || `Code=${envelope.Code}`) };
  }
  if (envelope.Success === false) {
    return { ok: false, data: envelope.Data ?? null, error: String(envelope.Text || envelope.Message || 'WechatPad 返回失败') };
  }
  if (envelope.Success === true) return { ok: true, data: envelope.Data ?? null };
  if ('ok' in envelope && envelope.ok === true) {
    const { ok: _ok, ...rest } = envelope;
    return { ok: true, data: rest };
  }
  return { ok: true, data: envelope };
}

/** Extract a server message id from a send receipt, when present. */
export function extractMessageId(data) {
  for (const item of iterateDicts(data)) {
    const list = item.chat_send_ret_list;
    if (Array.isArray(list) && list.length > 0 && list[0] && typeof list[0] === 'object') {
      const entry = list[0];
      const candidate = entry.newMsgId ?? entry.NewMsgId ?? entry.new_msg_id;
      if (candidate !== undefined && candidate !== null && String(candidate) !== '0') return String(candidate);
    }
    for (const key of ['NewMsgId', 'newMsgId', 'new_msg_id', 'MsgId', 'msgId']) {
      const value = item[key];
      if (value !== undefined && value !== null && String(value).trim() && String(value) !== '0') return String(value);
    }
  }
  return null;
}

function* iterateDicts(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* iterateDicts(child);
  } else if (value && typeof value === 'object') {
    yield value;
    for (const child of Object.values(value)) yield* iterateDicts(child);
  }
}

/** Whether a failure is worth retrying; permanent rejections are not. */
export function isRetryable(error) {
  const text = String(error ?? '').toLowerCase();
  if (!text) return false;
  if (BENIGN_MARKERS.some((marker) => text.includes(marker))) return false;
  if (['invalid', 'forbidden', 'unauthorized', 'not found', 'bad request', 'permission', 'denied', 'blocked', 'ret=-']
    .some((marker) => text.includes(marker))) return false;
  return RETRYABLE_MARKERS.some((marker) => text.includes(marker));
}

function describeNetworkError(error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `WechatPad 请求超时（${Math.round(timeoutMs / 1000)}s）`;
  }
  const cause = error?.cause;
  if (cause?.code === 'ECONNREFUSED') return 'WechatPad 连接被拒绝，请确认服务已启动且地址正确';
  if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') return 'WechatPad 地址无法解析';
  return error?.message ? String(error.message) : String(error);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
