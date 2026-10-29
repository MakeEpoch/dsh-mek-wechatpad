/**
 * 每个微信 iLink 机器人账号的状态落盘。
 *
 * 落盘位置：`~/.dsh/wechatpad/weixin-accounts/<botId>.json`（目录 0700，文件 0600）。
 * 三条硬规则：
 *  1. 原子写：先写 `.tmp` 再 rename，串行队列避免并发覆盖；
 *  2. 损坏即重置：JSON 解析失败按空态重建，ENOENT 视为空态；
 *  3. 不泄露凭证：`context_token` 只留在内存/文件里，`snapshot()` 一定剔除。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

import { weixinMessageTimestampMs } from './weixin-api.js';

/** 已处理消息 id 的保留上限（去重窗口）。 */
export const WEIXIN_SEEN_MESSAGE_LIMIT = 1000;
/** context_token 每账号最多保留的用户数。 */
export const WEIXIN_CONTEXT_TOKEN_LIMIT = 1000;
/** 最近出站消息保留条数。 */
export const WEIXIN_RECENT_OUTBOUND_LIMIT = 200;
/** 最近出站消息的存活时间。 */
export const WEIXIN_RECENT_OUTBOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 单条出站消息正文最多记这么多字符，只用于引用回填。 */
export const WEIXIN_RECENT_OUTBOUND_TEXT_LIMIT = 8000;
/** 用时间戳匹配出站消息时允许的误差。 */
export const WEIXIN_RECENT_OUTBOUND_MATCH_TOLERANCE_MS = 15_000;

/** 空态模板。每次使用都深拷贝，避免共享引用被改写。 */
const EMPTY_STATE = Object.freeze({
  version: 1,
  account: {},
  sessions: {},
  seenMessageIds: [],
  getUpdatesBuf: '',
  recentOutboundMessages: [],
});

/**
 * 状态读写异常，带稳定的 `code` 便于上层分类。
 */
export class WeixinStateError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WeixinStateError';
    this.code = code;
  }
}

/** 取非空字符串（去首尾空白）。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 规范化毫秒时间戳；非法值返回 null。 */
function timestamp(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

/**
 * 规范化协议序号。64 位序号超出 Number 安全范围，统一用十进制字符串比较。
 * @param {unknown} value
 * @returns {string | null}
 */
function sequence(value) {
  const text = typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  return /^\d{1,20}$/.test(text) ? text : null;
}

/** 比较两个十进制序号字符串。 */
function compareSequence(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 按码位截断，避免切坏代理对。 */
function truncateText(value) {
  const text = nonEmptyString(value);
  return text ? [...text].slice(0, WEIXIN_RECENT_OUTBOUND_TEXT_LIMIT).join('') : null;
}

/** 去重并规范化服务端消息 id 列表。 */
function normalizeMessageIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((id) => (id === undefined || id === null ? null : nonEmptyString(String(id))))
    .filter(Boolean))];
}

/** 规范化一条最近出站记录；不合法返回 null。 */
function normalizeRecentOutbound(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const toUserId = nonEmptyString(value.toUserId);
  const text = truncateText(value.text);
  const sentAt = timestamp(value.sentAt);
  const completedAt = timestamp(value.completedAt) ?? sentAt;
  if (!toUserId || !text || sentAt === null || completedAt === null) return null;
  return {
    toUserId,
    text,
    sentAt,
    completedAt: Math.max(sentAt, completedAt),
    providerMessageIds: normalizeMessageIds(value.providerMessageIds),
  };
}

/** 丢掉过期的出站记录并裁剪到上限。 */
function recentOutboundMessages(value, now = Date.now()) {
  if (!Array.isArray(value)) return [];
  const cutoff = now - WEIXIN_RECENT_OUTBOUND_TTL_MS;
  return value
    .map(normalizeRecentOutbound)
    .filter((entry) => entry && entry.completedAt >= cutoff)
    .slice(-WEIXIN_RECENT_OUTBOUND_LIMIT);
}

/** 规范化账号元信息，绝不保存任何 token。 */
function normalizeAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const account = {};
  const accountId = nonEmptyString(value.accountId);
  if (accountId) account.accountId = accountId;
  const ownerUserId = nonEmptyString(value.ownerUserId);
  if (ownerUserId) account.ownerUserId = ownerUserId;
  const baseUrl = nonEmptyString(value.baseUrl);
  if (baseUrl) account.baseUrl = baseUrl;
  for (const key of ['createdAt', 'connectedAt']) {
    const at = timestamp(value[key]);
    if (at !== null) account[key] = at;
  }
  return account;
}

/** 规范化 context_token 表：credentialHash 必须是 sha256 十六进制。 */
function normalizeContextTokens(value) {
  if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.credentialHash ?? '')) {
    return undefined;
  }
  const users = {};
  for (const [userId, entry] of Object.entries(value.users ?? {}).slice(-WEIXIN_CONTEXT_TOKEN_LIMIT)) {
    const token = nonEmptyString(entry?.token);
    if (!nonEmptyString(userId) || !token) continue;
    users[userId] = {
      token,
      seq: sequence(entry.seq),
      messageTimeMs: timestamp(entry.messageTimeMs),
      receivedAt: timestamp(entry.receivedAt),
    };
  }
  return { credentialHash: value.credentialHash, users };
}

/**
 * 把磁盘上的任意内容收敛成合法状态对象。
 * @param {unknown} value JSON.parse 后的原始值。
 */
function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    for (const [chatId, sessionId] of Object.entries(value.sessions)) {
      if (typeof chatId === 'string' && typeof sessionId === 'string' && sessionId) {
        sessions[chatId] = sessionId;
      }
    }
  }
  const contextTokens = normalizeContextTokens(value.contextTokens);
  const seenMessageIds = Array.isArray(value.seenMessageIds)
    ? [...new Set(value.seenMessageIds
      .map((id) => (typeof id === 'string' ? nonEmptyString(id) : null))
      .filter(Boolean))].slice(-WEIXIN_SEEN_MESSAGE_LIMIT)
    : [];
  return {
    version: 1,
    account: normalizeAccount(value.account),
    sessions,
    seenMessageIds,
    getUpdatesBuf: typeof value.getUpdatesBuf === 'string' ? value.getUpdatesBuf : '',
    recentOutboundMessages: recentOutboundMessages(value.recentOutboundMessages),
    ...(contextTokens ? { contextTokens } : {}),
  };
}

/**
 * 一个微信机器人账号的本地状态。
 */
export class WeixinAccountState {
  #botId;
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();

  /**
   * @param {string} botId 机器人账号 id，同时用于文件名（会做安全化处理）。
   */
  constructor(botId, { directory } = {}) {
    const id = nonEmptyString(botId);
    if (!id) throw new TypeError('botId is required');
    this.#botId = id;
    this.#path = WeixinAccountState.pathFor(id, directory);
  }

  /**
   * 账号状态文件路径。
   * @param {string} botId
   * @returns {string}
   */
  static pathFor(botId, directory) {
    const safe = String(botId ?? '').replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 128) || 'account';
    return directory ? join(directory, `${safe}.json`) : dshHomePath('wechatpad', 'weixin-accounts', `${safe}.json`);
  }

  /** 状态文件路径（只读）。 */
  get path() {
    return this.#path;
  }

  /**
   * 日志里唯一可以出现的账号标识：botId 的 sha256 前 12 位。
   * @returns {string}
   */
  get botIdHash() {
    return createHash('sha256').update(this.#botId).digest('hex').slice(0, 12);
  }

  /**
   * 读盘。文件不存在视为空态并立即建一个；损坏的 JSON 回退空态后重建。
   * @returns {Promise<this>}
   */
  async load() {
    let text;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#state = structuredClone(EMPTY_STATE);
        await this.#persist();
        return this;
      }
      throw new WeixinStateError('state-read-failed', '读取微信账号状态失败。', { cause: error });
    }
    try {
      this.#state = normalizeState(JSON.parse(text));
    } catch {
      // 损坏文件不做备份，直接按空态重建，避免把坏数据带进运行期。
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
      return this;
    }
    return this;
  }

  /**
   * 写入账号元信息（合并，不覆盖未提供字段）。
   * @param {{ accountId?: string, ownerUserId?: string, baseUrl?: string,
   *   createdAt?: number, connectedAt?: number }} patch
   */
  async setAccount(patch = {}) {
    const merged = normalizeAccount({ ...this.#state.account, ...patch });
    this.#state.account = merged;
    await this.#persist();
  }

  /** 当前账号元信息副本。 */
  account() {
    return structuredClone(this.#state.account);
  }

  /**
   * 把 context_token 表绑定到当前凭证：token 变了就整表作废。
   * @param {string} token bot token。
   */
  async bindContextTokens(token) {
    const text = nonEmptyString(token);
    if (!text) throw new TypeError('token is required');
    const credentialHash = createHash('sha256').update(text).digest('hex');
    if (this.#state.contextTokens?.credentialHash === credentialHash) return false;
    this.#state.contextTokens = { credentialHash, users: {} };
    await this.#persist();
    return true;
  }

  /**
   * 取某个用户的 context_token（用于回复时带上会话能力）。
   * @param {string} userId
   * @returns {string | undefined}
   */
  contextTokenFor(userId) {
    const user = nonEmptyString(userId);
    if (!user) return undefined;
    return this.#state.contextTokens?.users?.[user]?.token ?? undefined;
  }

  /**
   * 记住一条 context_token。旧序号/旧时间不得覆盖新值；超过上限淘汰最旧的用户。
   * @param {{ userId: string, contextToken: string, seq?: unknown, messageTimeMs?: unknown }} entry
   * @returns {Promise<boolean>} 是否真的更新了。
   */
  async rememberContextToken({ userId, contextToken, seq, messageTimeMs }) {
    const user = nonEmptyString(userId);
    const token = nonEmptyString(contextToken);
    if (!user || !token || !this.#state.contextTokens) return false;
    const users = this.#state.contextTokens.users;
    const next = {
      token,
      seq: sequence(seq),
      messageTimeMs: timestamp(messageTimeMs),
      receivedAt: Date.now(),
    };
    const previous = users[user];
    // 乱序/重投的批次不能把更新的会话凭证顶掉。
    if (previous) {
      if (previous.seq !== null && next.seq !== null && compareSequence(next.seq, previous.seq) <= 0) {
        return false;
      }
      if (previous.messageTimeMs !== null && next.messageTimeMs !== null
        && next.messageTimeMs < previous.messageTimeMs) {
        return false;
      }
    }
    // 重新插入到末尾，维持「越靠后越新」的淘汰顺序。
    delete users[user];
    users[user] = next;
    const keys = Object.keys(users);
    if (keys.length > WEIXIN_CONTEXT_TOKEN_LIMIT) delete users[keys[0]];
    await this.#persist();
    return true;
  }

  /**
   * chatId 绑定的 dsh 会话 id。
   * @param {string} chatId
   * @returns {string | null}
   */
  sessionFor(chatId) {
    return this.#state.sessions[chatId] ?? null;
  }

  /** 绑定会话。 */
  async setSession(chatId, sessionId) {
    const key = nonEmptyString(chatId);
    const value = nonEmptyString(sessionId);
    if (!key || !value) throw new TypeError('chatId and sessionId are required');
    this.#state.sessions[key] = value;
    await this.#persist();
  }

  /** 解绑单个会话。 */
  async clearSession(chatId) {
    if (!(chatId in this.#state.sessions)) return;
    delete this.#state.sessions[chatId];
    await this.#persist();
  }

  /** 清空全部会话绑定。 */
  async clearSessions() {
    if (Object.keys(this.#state.sessions).length === 0) return;
    this.#state.sessions = {};
    await this.#persist();
  }

  /** 当前全部会话绑定副本。 */
  sessions() {
    return { ...this.#state.sessions };
  }

  /**
   * 消息是否已处理过。
   * @param {string} messageId
   * @returns {boolean}
   */
  hasSeen(messageId) {
    const id = nonEmptyString(messageId);
    return Boolean(id) && this.#state.seenMessageIds.includes(id);
  }

  /**
   * 标记消息已处理，超出上限时丢弃最旧的。
   * @param {string} messageId
   */
  async markSeen(messageId) {
    const id = nonEmptyString(messageId);
    if (!id || this.hasSeen(id)) return false;
    this.#state.seenMessageIds.push(id);
    if (this.#state.seenMessageIds.length > WEIXIN_SEEN_MESSAGE_LIMIT) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - WEIXIN_SEEN_MESSAGE_LIMIT);
    }
    await this.#persist();
    return true;
  }

  /** getupdates 的续传游标。 */
  getUpdatesBuf() {
    return this.#state.getUpdatesBuf;
  }

  /** 更新续传游标；值未变则不写盘。 */
  async setGetUpdatesBuf(value) {
    if (typeof value !== 'string' || value === this.#state.getUpdatesBuf) return false;
    this.#state.getUpdatesBuf = value;
    await this.#persist();
    return true;
  }

  /**
   * 记录一条已发出的消息，供后续「引用回复」找回原文明。
   * @param {{ toUserId: string, text: string, sentAt?: number, completedAt?: number,
   *   providerMessageIds?: string[] }} entry
   */
  async rememberOutboundMessage({
    toUserId,
    text,
    sentAt = Date.now(),
    completedAt = Date.now(),
    providerMessageIds = [],
  } = {}) {
    const entry = normalizeRecentOutbound({ toUserId, text, sentAt, completedAt, providerMessageIds });
    if (!entry) throw new TypeError('Invalid Weixin outbound message');
    this.#state.recentOutboundMessages = recentOutboundMessages([
      ...this.#state.recentOutboundMessages,
      entry,
    ]);
    await this.#persist();
  }

  /**
   * 根据被引用消息的 id/时间找回我们之前发出的原文。
   * 先精确匹配 providerMessageIds；匹配不到再用时间窗，且只在唯一命中时返回。
   * @param {{ toUserId: string, messageId?: string, createTimeMs?: number,
   *   updateTimeMs?: number, now?: number }} query
   * @returns {string | null}
   */
  recentOutboundTextFor({ toUserId, messageId, createTimeMs, updateTimeMs, now = Date.now() } = {}) {
    const recipient = nonEmptyString(toUserId);
    if (!recipient) return null;
    const active = recentOutboundMessages(this.#state.recentOutboundMessages, now)
      .filter((entry) => entry.toUserId === recipient);
    const quotedMessageId = messageId === undefined || messageId === null
      ? null
      : nonEmptyString(String(messageId));
    if (quotedMessageId) {
      const exact = active.filter((entry) => entry.providerMessageIds.includes(quotedMessageId));
      if (exact.length === 1) return exact[0].text;
      if (exact.length > 1) return null;
    }
    const quotedTimes = [
      timestamp(createTimeMs),
      timestamp(updateTimeMs),
      weixinMessageTimestampMs(quotedMessageId, { now }),
    ].filter((value) => value !== null);
    if (quotedTimes.length === 0) return null;
    const candidates = active.filter((entry) => quotedTimes.some((quotedAt) => (
      quotedAt >= entry.sentAt - WEIXIN_RECENT_OUTBOUND_MATCH_TOLERANCE_MS
        && quotedAt <= entry.completedAt + WEIXIN_RECENT_OUTBOUND_MATCH_TOLERANCE_MS
    )));
    return candidates.length === 1 ? candidates[0].text : null;
  }

  /**
   * 可安全展示/落日志的状态快照：一定不含 contextTokens 与任何 token。
   * @returns {object}
   */
  snapshot() {
    const { contextTokens, ...state } = this.#state;
    return structuredClone(state);
  }

  /**
   * 供设置页展示的精简状态：只有布尔量与计数，凭据只体现「有/无」。
   * @returns {object}
   */
  status() {
    const users = Object.keys(this.#state.contextTokens?.users ?? {}).length;
    return {
      botIdHash: this.botIdHash,
      accountId: this.#state.account.accountId ?? null,
      hasContextTokens: users > 0 ? 'yes' : 'no',
      sessionCount: Object.keys(this.#state.sessions).length,
      seenMessageCount: this.#state.seenMessageIds.length,
      recentOutboundCount: this.#state.recentOutboundMessages.length,
      hasGetUpdatesBuf: this.#state.getUpdatesBuf ? 'yes' : 'no',
    };
  }

  /** 删除状态文件并回到内存空态。 */
  async remove() {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new WeixinStateError('state-cleanup-failed', '删除微信账号状态失败。', { cause: error });
      }
    }
    this.#state = structuredClone(EMPTY_STATE);
  }

  /**
   * 原子落盘：串行队列 + 临时文件 rename。
   */
  async #persist() {
    const payload = `${JSON.stringify(this.#state, null, 2)}\n`;
    const target = this.#path;
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation.catch((error) => {
      throw new WeixinStateError('state-write-failed', '写入微信账号状态失败。', { cause: error });
    });
  }
}

export { normalizeState as normalizeWeixinAccountState };
