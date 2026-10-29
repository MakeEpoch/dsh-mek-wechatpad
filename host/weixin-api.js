/**
 * 微信 iLink（微信开放平台机器人）协议客户端。
 *
 * 与 WechatPad 走本地 HTTP 不同，iLink 是腾讯托管的机器人协议：
 *  1. 扫码登录（get_bot_qrcode + get_qrcode_status 长轮询）换回 bot token；
 *  2. 之后用 token 长轮询 getupdates 收消息、sendmessage 发消息；
 *  3. 连接地址由服务端下发（`baseurl`），必须先过主机白名单才允许请求。
 *
 * 本模块只做协议层：不落盘、不管会话、不引第三方依赖，fetch 可注入便于测试。
 */
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

/** 扫码登录固定入口。 */
export const WEIXIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/';
/** 协议版本，随 base_info.channel_version 上报。 */
export const WEIXIN_PROTOCOL_VERSION = '2.4.6';
/** iLink 机器人类型：3 = 微信客服/机器人。 */
export const DEFAULT_BOT_TYPE = '3';
/** 文件上传下载所在的 CDN 前缀。 */
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** 单条文本消息默认上限，超过就分段发送。 */
export const DEFAULT_WEIXIN_MAX_MESSAGE_CHARS = 1800;

const WEIXIN_CDN_HOST = 'novac2c.cdn.weixin.qq.com';
const ILINK_APP_ID = 'bot';
/** (2 << 16) | (4 << 8) | 6，对应 2.4.6。 */
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const BOT_AGENT = 'DeepSeekHarness/1.1.0';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const WEIXIN_CDN_UPLOAD_CHUNK_BYTES = 64 * 1024;
const WEIXIN_MESSAGE_ID_TIMESTAMP_SHIFT = 22n;
const WEIXIN_MESSAGE_ID_MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const WEIXIN_MESSAGE_ID_MAX_FUTURE_MS = 24 * 60 * 60 * 1_000;
/** 分段时换行切点允许的最早位置（相对上限的比例）。 */
const SPLIT_BREAKPOINT_MIN_RATIO = 0.6;
/** 扫码状态的全部合法取值。 */
const LOGIN_STATUSES = new Set([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'scaned_but_redirect',
  'need_verifycode',
  'verify_code_blocked',
  'binded_redirect',
]);
/** 这些错误码表示网络层没拿到确定结果，重发可能造成重复消息。 */
const UNCERTAIN_CODES = new Set(['network-error', 'timeout', 'invalid-response']);

/**
 * 协议层错误。`code` 是稳定的分类，调用方可据此决定是否重试/是否提示重新登录。
 */
export class WeixinApiError extends Error {
  /**
   * @param {string} code 错误分类，如 `timeout`、`send-rejected`。
   * @param {string} message 面向用户的中文说明。
   * @param {{ cause?: unknown, status?: number, providerCode?: string, durationMs?: number }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WeixinApiError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
    if (options.durationMs !== undefined) this.durationMs = options.durationMs;
  }
}

/**
 * 取非空字符串（去首尾空白）。
 * @param {unknown} value
 * @returns {string | null}
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 把服务端返回的数值错误码收敛成可安全落日志的短字符串。
 * @param {unknown} value
 * @returns {string | undefined}
 */
function safeProviderCode(value) {
  const code = value === undefined || value === null ? null : String(value).trim();
  return code && /^-?[A-Za-z0-9_.:-]{1,160}$/.test(code) ? code : undefined;
}

/**
 * 检查 iLink 报文里的 ret / errcode，非 0 即视为被拒绝。
 * @param {unknown} value 服务端 JSON。
 * @param {string[]} [fields] 依次检查的字段。
 * @returns {string | null} 被拒绝时返回错误码字符串。
 */
export function rejectedProviderResponse(value, fields = ['ret', 'errcode']) {
  if (!value || typeof value !== 'object') return null;
  for (const field of fields) {
    if (value[field] !== undefined && value[field] !== 0 && value[field] !== '0') {
      return safeProviderCode(value[field]) ?? 'rejected';
    }
  }
  return null;
}

/**
 * 接收方地址是否属于腾讯微信域。`untrusted-*` 之类的伪造主机一律拒。
 * @param {string} hostname `URL#hostname`。
 * @returns {boolean}
 */
export function isWeixinHost(hostname) {
  const normalized = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.startsWith('untrusted-')) return false;
  return normalized === 'weixin.qq.com' || normalized.endsWith('.weixin.qq.com')
    || normalized === 'wechat.com' || normalized.endsWith('.wechat.com');
}

/**
 * 校验并规范化服务端下发的 API 基址：去 query/hash、补尾斜杠、端口只允许空或 443。
 * @param {string} value
 * @returns {string}
 * @throws {WeixinApiError} `invalid-base-url` / `untrusted-base-url`
 */
export function normalizeWeixinApiBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch (error) {
    throw new WeixinApiError('invalid-base-url', '微信服务返回了无效的连接地址。', { cause: error });
  }
  if (url.protocol !== 'https:' || url.username || url.password || !isWeixinHost(url.hostname)
    || (url.port !== '' && url.port !== '443')) {
    throw new WeixinApiError('untrusted-base-url', '微信服务返回了不受信任的连接地址。');
  }
  url.port = '';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

/**
 * 扫码地址白名单：https 且落在微信域（liteapp.weixin.qq.com 等）。
 * @param {string} value
 * @returns {string}
 */
export function normalizeWeixinQrUrl(value) {
  const text = nonEmptyString(value);
  if (!text) throw new WeixinApiError('invalid-qr', '微信服务没有返回扫码地址。');
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new WeixinApiError('invalid-qr', '微信服务返回了无效的扫码地址。', { cause: error });
  }
  if (url.protocol !== 'https:' || url.username || url.password || !isWeixinHost(url.hostname)
    || (url.port !== '' && url.port !== '443')) {
    throw new WeixinApiError('untrusted-qr', '微信服务返回了不受信任的扫码地址。');
  }
  url.port = '';
  return url.toString();
}

/** iLink 通用请求头，不带鉴权信息。 */
export function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
  };
}

/**
 * 鉴权请求头：通用头 + JSON content-type + bot token。
 * `X-WECHAT-UIN` 每次随机，服务端用它做端侧去重/会话粘连。
 * @param {string} token bot token。
 */
export function authenticatedHeaders(token) {
  const headers = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  };
  const trimmed = nonEmptyString(token);
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`;
  return headers;
}

/** 每个请求体都要带的协议指纹。 */
function baseInfo() {
  return {
    channel_version: WEIXIN_PROTOCOL_VERSION,
    bot_agent: BOT_AGENT,
  };
}

/** AES-128-ECB 带 PKCS#7 填充后的密文长度。 */
function aesEcbPaddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16;
}

/** 把 AbortSignal 的中断原因还原成异常。 */
function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

/**
 * 统一的 JSON 请求：负责主机校验、超时、AbortSignal 合并与错误分类。
 * @param {typeof fetch} fetchImpl
 * @param {object} options
 * @returns {Promise<any>}
 */
async function requestJson(fetchImpl, {
  method,
  baseUrl,
  endpoint,
  body,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  authenticated = true,
}) {
  const trustedBase = normalizeWeixinApiBaseUrl(baseUrl);
  const url = new URL(endpoint, trustedBase);
  // 相对路径理论上不会跳域，但二次校验可以拦住 endpoint 里夹带的绝对地址。
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new WeixinApiError('untrusted-endpoint', '拒绝访问不受信任的微信服务地址。');
  }

  if (signal?.aborted) throw abortError(signal);
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;

  try {
    const response = await fetchImpl(url, {
      method,
      headers: authenticated ? authenticatedHeaders(token) : commonHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response?.ok) {
      throw new WeixinApiError(
        'http-error',
        `微信服务请求失败（HTTP ${response?.status ?? 'unknown'}）。`,
        { status: response?.status },
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WeixinApiError('invalid-response', '微信服务返回了无法解析的响应。', { cause: error });
    }
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    let failure;
    if (timedOut) {
      failure = new WeixinApiError('timeout', '微信服务请求超时。', { cause: error });
    } else if (error instanceof WeixinApiError) {
      failure = error;
      failure.durationMs = Date.now() - startedAt;
    } else {
      failure = new WeixinApiError('network-error', '暂时无法访问微信服务。', { cause: error });
    }
    failure.durationMs = Date.now() - startedAt;
    throw failure;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 从一条 iLink 消息里取出可直接展示的文本：type1 文本项、type3 语音转写。
 * @param {unknown} message
 * @returns {string | null}
 */
export function extractWeixinText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim();
      if (text) return text;
    }
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * 消息的稳定标识：优先服务端 `message_id`，否则退回 `client_id`。
 * @param {unknown} message
 * @returns {string | null}
 */
export function weixinMessageId(message) {
  if (message?.message_id !== undefined && message?.message_id !== null) {
    return String(message.message_id);
  }
  return nonEmptyString(message?.client_id);
}

/**
 * 64 位 iLink 消息 id 的高 42 位是毫秒时间戳（右移 22 位）。
 * 结果必须落在 2020-01-01 与当前时间 + 24h 之间，否则视为不可信返回 null。
 * @param {string | number} messageId
 * @param {{ now?: number }} [options]
 * @returns {number | null}
 */
export function weixinMessageTimestampMs(messageId, { now = Date.now() } = {}) {
  const value = messageId === undefined || messageId === null ? '' : String(messageId).trim();
  if (!/^\d{1,20}$/.test(value)) return null;
  let timestampMs;
  try {
    timestampMs = Number(BigInt(value) >> WEIXIN_MESSAGE_ID_TIMESTAMP_SHIFT);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) return null;
  if (timestampMs < WEIXIN_MESSAGE_ID_MIN_TIMESTAMP_MS) return null;
  if (timestampMs > now + WEIXIN_MESSAGE_ID_MAX_FUTURE_MS) return null;
  return timestampMs;
}

/**
 * 按协议序号排序：所有消息都有 `seq` 时用 seq，否则退到 `create_time_ms`。
 * 两者都缺时保持原顺序；相等序号按数组下标稳定排序。
 * @param {unknown[]} messages
 * @returns {unknown[]}
 */
export function orderWeixinMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return Array.isArray(messages) ? messages : [];
  const numeric = (value) => (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
  const orderField = ['seq', 'create_time_ms'].find((field) => (
    messages.every((message) => numeric(message?.[field]))
  ));
  if (!orderField) return messages;
  return messages
    .map((message, index) => ({ message, index, order: Number(message[orderField]) }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ message }) => message);
}

/**
 * 把长文本切成不超过 `maxChars` 的若干段。
 * 优先在 `\n` 处断开，但切点不能早于上限的 60%，避免切出过多碎片。
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function splitWeixinText(text, maxChars = DEFAULT_WEIXIN_MAX_MESSAGE_CHARS) {
  const source = String(text ?? '');
  if (!source) return [];
  const limit = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : DEFAULT_WEIXIN_MAX_MESSAGE_CHARS;
  if (source.length <= limit) return [source];
  const chunks = [];
  let remaining = source;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < Math.floor(limit * SPLIT_BREAKPOINT_MIN_RATIO)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** 引用消息里被引条目的附件归类。 */
function weixinReplyAttachment(item) {
  if (item?.type === 2 || (item?.image_item && typeof item.image_item === 'object')) {
    return { kind: 'image' };
  }
  if (item?.type === 3 || (item?.voice_item && typeof item.voice_item === 'object')) {
    return { kind: 'audio' };
  }
  if (item?.type === 4 || (item?.file_item && typeof item.file_item === 'object')) {
    const name = nonEmptyString(item?.file_item?.file_name);
    return { kind: 'file', ...(name ? { name } : {}) };
  }
  if (item?.type === 5 || (item?.video_item && typeof item.video_item === 'object')) {
    return { kind: 'video' };
  }
  return null;
}

/** 引用条目里的文本（文本项或语音转写）。 */
function weixinQuotedText(item) {
  return nonEmptyString(item?.text_item?.text) ?? nonEmptyString(item?.voice_item?.text);
}

/**
 * 解析入站消息里嵌的一层引用快照（ref_msg）。
 * 拿不到内容时，可交给 `resolveContent`（如从最近的出站记录里找回原文）。
 * @param {unknown} message
 * @param {{ resolveContent?: (details: object) => unknown }} [options]
 * @returns {{ messageId?: string, content?: string, attachments?: object[], unavailableReason?: string } | null}
 */
export function extractWeixinReplyReference(message, { resolveContent } = {}) {
  const container = (message?.item_list ?? []).find((item) => (
    item?.ref_msg && typeof item.ref_msg === 'object'
  ));
  if (!container) return null;
  const ref = container.ref_msg;
  const quotedItem = ref.message_item && typeof ref.message_item === 'object' ? ref.message_item : null;
  const messageId = quotedItem?.msg_id === undefined || quotedItem?.msg_id === null
    ? null
    : nonEmptyString(String(quotedItem.msg_id));
  const referenceDetails = {
    messageId,
    createTimeMs: quotedItem?.create_time_ms ?? ref.create_time_ms,
    updateTimeMs: quotedItem?.update_time_ms ?? ref.update_time_ms,
  };

  let content = weixinQuotedText(quotedItem) ?? nonEmptyString(ref.title);
  const attachment = weixinReplyAttachment(quotedItem);
  if (!content && !attachment && typeof resolveContent === 'function') {
    content = nonEmptyString(resolveContent(referenceDetails));
  }

  const knownTypes = new Set([1, 2, 3, 4, 5, 8]);
  const unresolved = !content && !attachment;
  return {
    ...(messageId ? { messageId } : {}),
    ...(content ? { content } : {}),
    ...(attachment ? { attachments: [attachment] } : {}),
    ...(unresolved
      ? { unavailableReason: quotedItem && !knownTypes.has(quotedItem.type) ? 'unsupported' : 'not-delivered' }
      : {}),
  };
}

/** CDN 上传地址白名单：必须是 c2c/upload 且落在 CDN 域。 */
function trustedWeixinCdnUploadUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch (error) {
    throw new WeixinApiError('invalid-upload-url', '微信服务返回了无效的文件上传地址。', { cause: error });
  }
  if (url.protocol !== 'https:' || url.hostname !== WEIXIN_CDN_HOST || url.username || url.password
    || (url.port !== '' && url.port !== '443') || url.pathname !== '/c2c/upload') {
    throw new WeixinApiError('untrusted-upload-url', '微信服务返回了不受信任的文件上传地址。');
  }
  url.port = '';
  url.hash = '';
  return url;
}

/** 由 getuploadurl 的响应推导实际上传地址。 */
function weixinCdnUploadUrl(response, fileKey) {
  const fullUrl = nonEmptyString(response?.upload_full_url);
  if (fullUrl) return trustedWeixinCdnUploadUrl(fullUrl);
  const uploadParam = nonEmptyString(response?.upload_param);
  if (!uploadParam) {
    throw new WeixinApiError('missing-upload-url', '微信服务没有返回文件上传地址。');
  }
  const url = new URL(`${WEIXIN_CDN_BASE_URL}/upload`);
  url.searchParams.set('encrypted_query_param', uploadParam);
  url.searchParams.set('filekey', fileKey);
  return trustedWeixinCdnUploadUrl(url);
}

/**
 * 分块加密成 aes-128-ecb 密文流：边加密边交给 fetch，避免整份密文驻留内存。
 */
async function* encryptWeixinUpload(bytes, key, signal) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  for (let offset = 0; offset < bytes.byteLength; offset += WEIXIN_CDN_UPLOAD_CHUNK_BYTES) {
    signal?.throwIfAborted();
    const chunk = cipher.update(bytes.subarray(offset, offset + WEIXIN_CDN_UPLOAD_CHUNK_BYTES));
    if (chunk.byteLength) yield chunk;
  }
  signal?.throwIfAborted();
  yield cipher.final();
}

/**
 * 把明文上传到 CDN，返回下载用的 `encrypt_query_param`。
 * @returns {Promise<string>}
 */
async function uploadWeixinCdn(fetchImpl, url, bytes, key, { signal } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(aesEcbPaddedSize(bytes.byteLength)),
      },
      body: encryptWeixinUpload(bytes, key, signal),
      duplex: 'half',
      signal,
      redirect: 'error',
    });
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw new WeixinApiError(
      'upload-failed',
      '微信文件上传失败。',
      { cause: error, status: Number(error?.status) || undefined },
    );
  }
  if (response?.status !== 200) {
    const status = response?.status;
    throw new WeixinApiError(
      status >= 400 && status < 500 ? 'upload-rejected' : 'upload-failed',
      `微信文件上传失败（HTTP ${status ?? 'unknown'}）。`,
      { status },
    );
  }
  const downloadParam = nonEmptyString(response.headers?.get?.('x-encrypted-param'));
  if (!downloadParam) {
    throw new WeixinApiError('invalid-upload-response', '微信文件上传响应缺少下载参数。');
  }
  return downloadParam;
}

/**
 * 创建 iLink 协议客户端。返回对象已冻结，方法均可安全并发调用。
 * @param {{ fetchImpl?: typeof fetch, uploadFetchImpl?: typeof fetch }} [options]
 */
export function createWeixinApi({ fetchImpl = fetch, uploadFetchImpl = fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof uploadFetchImpl !== 'function') throw new TypeError('uploadFetchImpl must be a function');

  /**
   * 文件/图片发送骨架：getuploadurl → 加密上传 CDN → sendmessage。
   * 图片使用原生图片消息，其他附件使用文件消息。
   */
  async function sendArtifact({ baseUrl, token, toUserId, file, contextToken, runId, signal }, { mediaType, itemType }) {
    const recipient = nonEmptyString(toUserId);
    if (!recipient || !file || typeof file !== 'object'
      || typeof file.fileName !== 'string' || !file.fileName
      || !Buffer.isBuffer(file.bytes)) {
      throw new TypeError('toUserId 与非空 file.bytes 是必需的');
    }
    signal?.throwIfAborted();
    const fileKey = randomBytes(16).toString('hex');
    const aesKey = randomBytes(16);
    const upload = await requestJson(fetchImpl, {
      method: 'POST',
      baseUrl,
      endpoint: 'ilink/bot/getuploadurl',
      token,
      signal,
      body: {
        filekey: fileKey,
        media_type: mediaType,
        to_user_id: recipient,
        rawsize: file.bytes.byteLength,
        rawfilemd5: createHash('md5').update(file.bytes).digest('hex'),
        filesize: aesEcbPaddedSize(file.bytes.byteLength),
        no_need_thumb: true,
        aeskey: aesKey.toString('hex'),
        base_info: baseInfo(),
      },
    });
    const uploadRejection = rejectedProviderResponse(upload);
    if (uploadRejection) {
      throw new WeixinApiError('upload-url-rejected', '微信服务拒绝了文件上传请求。', {
        providerCode: uploadRejection,
      });
    }
    const uploadUrl = weixinCdnUploadUrl(upload, fileKey);
    const downloadParam = await uploadWeixinCdn(uploadFetchImpl, uploadUrl, file.bytes, aesKey, { signal });
    signal?.throwIfAborted();

    const media = {
      encrypt_query_param: downloadParam,
      aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
      encrypt_type: 1,
    };
    const ciphertextSize = aesEcbPaddedSize(file.bytes.byteLength);
    const clientId = `dsh-wechatpad-${randomUUID()}`;
    const item = itemType === 2
      ? { type: 2, image_item: { media, mid_size: ciphertextSize } }
      : { type: 4, file_item: { media, file_name: file.fileName, len: String(file.bytes.byteLength) } };
    const response = await requestJson(fetchImpl, {
      method: 'POST',
      baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      token,
      signal,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: recipient,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [item],
          ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
          ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
        },
        base_info: baseInfo(),
      },
    });
    const sendRejection = rejectedProviderResponse(response);
    if (sendRejection) {
      throw new WeixinApiError('send-rejected', '微信服务拒绝了文件消息。', { providerCode: sendRejection });
    }
    return { messageId: clientId, providerMessageIds: [clientId] };
  }

  return Object.freeze({
    /**
     * 申请登录二维码。
     * @param {{ localTokens?: string[], botType?: string, signal?: AbortSignal }} [options]
     * @returns {Promise<{ qrcode: string, qrcodeUrl: string }>}
     */
    async beginLogin({ localTokens = [], botType = DEFAULT_BOT_TYPE, signal } = {}) {
      const tokens = [...new Set(localTokens.map(nonEmptyString).filter(Boolean))].slice(-10);
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl: WEIXIN_QR_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType || DEFAULT_BOT_TYPE)}`,
        body: { local_token_list: tokens, base_info: baseInfo() },
        timeoutMs: 10_000,
        signal,
      });
      const providerCode = rejectedProviderResponse(response, ['errcode', 'ret']);
      if (providerCode) {
        throw new WeixinApiError('qr-request-rejected', '微信服务拒绝了二维码申请。', { providerCode });
      }
      const qrcode = nonEmptyString(response?.qrcode);
      if (!qrcode) throw new WeixinApiError('invalid-qr', '微信服务没有返回二维码令牌。');
      return { qrcode, qrcodeUrl: normalizeWeixinQrUrl(response.qrcode_img_content) };
    },

    /**
     * 长轮询扫码状态（35s，不鉴权）。`baseUrl` 是上一轮可能下发的重定向地址。
     * @returns {Promise<{ status: string, [key: string]: unknown }>}
     */
    async pollLogin({ qrcode, baseUrl = WEIXIN_QR_BASE_URL, verifyCode, signal }) {
      const qr = nonEmptyString(qrcode);
      if (!qr) throw new TypeError('qrcode is required');
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`;
      if (nonEmptyString(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`;
      const response = await requestJson(fetchImpl, {
        method: 'GET',
        baseUrl,
        endpoint,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        signal,
        authenticated: false,
      });
      if (!response || typeof response !== 'object' || !LOGIN_STATUSES.has(response.status)) {
        throw new WeixinApiError('invalid-login-status', '微信服务返回了无法识别的扫码状态。');
      }
      return response;
    },

    /**
     * 长轮询取消息。超时是正常现象（无新消息），直接返回空批次而不是抛错。
     * @returns {Promise<{ ret: number, msgs: unknown[], get_updates_buf: string }>}
     */
    async getUpdates({ baseUrl, token, getUpdatesBuf = '', timeoutMs, signal }) {
      const buffer = typeof getUpdatesBuf === 'string' ? getUpdatesBuf : '';
      try {
        return await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: buffer, base_info: baseInfo() },
          token,
          timeoutMs: timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
          signal,
        });
      } catch (error) {
        if (error instanceof WeixinApiError && error.code === 'timeout' && !signal?.aborted) {
          return { ret: 0, msgs: [], get_updates_buf: buffer };
        }
        throw error;
      }
    },

    /**
     * 取会话配置，主要是发「正在输入」所需的 typing_ticket。
     * @returns {Promise<{ typingTicket: string | null }>}
     */
    async getConfig({ baseUrl, token, toUserId, contextToken, signal }) {
      const recipient = nonEmptyString(toUserId);
      if (!recipient) throw new TypeError('toUserId is required');
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/getconfig',
        token,
        signal,
        timeoutMs: 10_000,
        body: {
          ilink_user_id: recipient,
          ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
          base_info: baseInfo(),
        },
      });
      const rejection = rejectedProviderResponse(response);
      if (rejection) {
        throw new WeixinApiError('config-rejected', '微信服务拒绝了机器人配置请求。', { providerCode: rejection });
      }
      return { typingTicket: nonEmptyString(response?.typing_ticket) };
    },

    /**
     * 发送输入中状态：status 1 = 开始输入，2 = 结束输入。
     */
    async sendTyping({ baseUrl, token, toUserId, typingTicket, status, signal }) {
      const recipient = nonEmptyString(toUserId);
      const ticket = nonEmptyString(typingTicket);
      if (!recipient || !ticket) throw new TypeError('toUserId and typingTicket are required');
      if (status !== 1 && status !== 2) throw new TypeError('typing status must be 1 or 2');
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        token,
        signal,
        timeoutMs: 10_000,
        body: {
          ilink_user_id: recipient,
          typing_ticket: ticket,
          status,
          base_info: baseInfo(),
        },
      });
      const rejection = rejectedProviderResponse(response);
      if (rejection) {
        throw new WeixinApiError('typing-rejected', '微信服务拒绝了输入状态请求。', { providerCode: rejection });
      }
      return true;
    },

    /**
     * 发一条文本消息。
     * @param {{ baseUrl: string, token: string, toUserId: string, text: string,
     *   contextToken?: string, runId?: string, signal?: AbortSignal }} request
     * @returns {Promise<{ providerMessageIds: string[] } & Record<string, unknown>>}
     * @throws {WeixinApiError} `send-rejected` 携带 providerCode。
     */
    async sendText({ baseUrl, token, toUserId, text, contextToken, runId, signal }) {
      const recipient = nonEmptyString(toUserId);
      const content = nonEmptyString(text);
      if (!recipient || !content) throw new TypeError('toUserId and text are required');
      const clientId = `dsh-wechatpad-${randomUUID()}`;
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: recipient,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: content } }],
            ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
            ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
          },
          base_info: baseInfo(),
        },
      });
      const rejection = rejectedProviderResponse(response);
      if (rejection) {
        throw new WeixinApiError('send-rejected', '微信服务拒绝了回复消息。', { providerCode: rejection });
      }
      return {
        ...(response && typeof response === 'object' ? response : {}),
        providerMessageIds: [clientId],
      };
    },

    /** 发图片（协议骨架，本阶段未接线）。`file = { fileName, bytes: Buffer }`。 */
    async sendImage(request) {
      return sendArtifact(request, { mediaType: 1, itemType: 2 });
    },

    /** 发文件（协议骨架，本阶段未接线）。`file = { fileName, bytes: Buffer }`。 */
    async sendFile(request) {
      return sendArtifact(request, { mediaType: 3, itemType: 4 });
    },

    /** 通知服务端机器人上线；ret=-14 表示 token 已失效。 */
    async notifyStart({ baseUrl, token, signal }) {
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystart',
        token,
        signal,
        timeoutMs: 10_000,
        body: { base_info: baseInfo() },
      });
      const providerCode = rejectedProviderResponse(response, ['errcode', 'ret']);
      if (providerCode) {
        throw new WeixinApiError(
          providerCode === '-14' ? 'stale-token' : 'start-rejected',
          providerCode === '-14' ? '微信登录已失效，请重新扫码。' : '微信账号连接启动失败。',
          { providerCode },
        );
      }
      return response;
    },

    /** 通知服务端机器人下线。 */
    async notifyStop({ baseUrl, token, signal }) {
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystop',
        token,
        signal,
        timeoutMs: 10_000,
        body: { base_info: baseInfo() },
      });
      const providerCode = rejectedProviderResponse(response, ['errcode', 'ret']);
      if (providerCode) {
        throw new WeixinApiError('stop-rejected', '微信服务未确认停止通知。', { providerCode });
      }
      return response;
    },

    /**
     * 设置页「测试连接」用的轻量探针：一次短超时的 getupdates。
     * 只要服务端回了 JSON 且没有 ret 拒绝，就算连通。
     * @returns {Promise<{ ok: boolean, latencyMs: number, error?: { code: string, message: string, providerCode?: string } }>}
     */
    async testConnection({ baseUrl, token, timeoutMs = 8_000, signal } = {}) {
      const startedAt = Date.now();
      try {
        const response = await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: '', base_info: baseInfo() },
          token,
          timeoutMs,
          signal,
        });
        const rejection = rejectedProviderResponse(response);
        if (rejection) {
          return {
            ok: false,
            latencyMs: Date.now() - startedAt,
            error: rejection === '-14'
              ? { code: 'stale-token', message: '微信登录已失效，请重新扫码。', providerCode: rejection }
              : { code: 'probe-rejected', message: '微信服务拒绝了连接请求。', providerCode: rejection },
          };
        }
        return { ok: true, latencyMs: Date.now() - startedAt };
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: {
            code: UNCERTAIN_CODES.has(error?.code) ? error.code : (error?.code ?? 'network-error'),
            message: error?.message ? String(error.message) : String(error),
            ...(error?.providerCode ? { providerCode: error.providerCode } : {}),
          },
        };
      }
    },
  });
}
