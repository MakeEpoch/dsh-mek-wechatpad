/**
 * Inbound WechatPad message decoding.
 *
 * WechatPad pushes raw WeChat message objects. This module turns one into the
 * small, policy-relevant shape the bridge needs. Media stays lazy: the adapter
 * attaches download descriptors, and the service downloads only after policy
 * admission, before submitting actual image bytes or file paths to dsh.
 */

export const MSG_TEXT = 1;
export const MSG_IMAGE = 3;
export const MSG_VOICE = 34;
export const MSG_VIDEO = 43;
export const MSG_EMOJI = 47;
export const MSG_APP = 49;
export const MSG_SYSTEM = 10000;

const MEDIA_PLACEHOLDER = {
  [MSG_IMAGE]: '[图片]',
  [MSG_EMOJI]: '[表情]',
  [MSG_VOICE]: '[语音消息]',
  [MSG_VIDEO]: '[视频]',
  [MSG_APP]: '[链接/文件]',
};

/** Only these notices are treated as "someone mentioned the bot" in a group. */
const GROUP_MENTION_PATTERN = (wxid) => (wxid ? new RegExp(`@${escapeRegExp(wxid)}\\u2005`, 'u') : null);

/**
 * Decode one raw payload into a message record.
 * @param {unknown} payload raw WechatPad push payload.
 * @returns {null | {
 *   messageId: string,
 *   chatId: string,
 *   isGroup: boolean,
 *   senderId: string,
 *   text: string,
 *   msgType: number,
 *   mentioned: boolean,
 *   createdAt: number,
 *   rawAtUsers: string[],
 * }}
 */
export function decodeMessage(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const record = /** @type {Record<string, any>} */ (payload);
  const selfWxid = String(options.selfWxid ?? '').trim();
  const selfNickname = String(options.selfNickname ?? '').trim();

  const fromUser = nestedString(record, 'from_user_name', 'str') || String(record.FromUserName ?? '');
  const toUser = nestedString(record, 'to_user_name', 'str') || String(record.ToUserName ?? '');
  const messageId = String(record.new_msg_id ?? record.NewMsgId ?? record.msg_id ?? record.MsgId ?? '').trim();
  const msgType = Number(record.msg_type ?? record.MsgType ?? 0);
  if (!fromUser && !toUser) return null;

  // The peer is always the other party: the Pad is logged into one account, so
  // its own wxid appears on whichever side the push happens to fill in.
  const isGroup = fromUser.endsWith('@chatroom') || toUser.endsWith('@chatroom');
  const chatId = isGroup ? (fromUser.endsWith('@chatroom') ? fromUser : toUser) : fromUser;
  let senderId = fromUser;
  let body = nestedString(record, 'content', 'str') || String(record.Content ?? record.TextContent ?? '');

  if (isGroup) {
    // Group pushes prefix the body with the speaker's wxid followed by ":\n".
    // That prefix goes first: a sender id such as `sender_fixture@openim`
    // itself contains "@", which would otherwise read as an address.
    const split = /^([A-Za-z0-9_-]+@[A-Za-z0-9.-]+|[A-Za-z0-9_-]+):\n/.exec(body ?? '');
    if (split) {
      senderId = split[1];
      body = body.slice(split[0].length);
    } else {
      // A message whose sender is missing was sent by the bot itself.
      senderId = '';
    }
  }

  const atUsers = Array.isArray(record.AtWxIDList)
    ? record.AtWxIDList.map(String)
    : Array.isArray(record.at_wxid_list)
      ? record.at_wxid_list.map(String)
      : [];

  if (msgType !== MSG_TEXT && msgType !== MSG_SYSTEM) body = '';

  // Three independent signals decide whether this group message addresses the
  // bot, strongest first:
  //   1. `<atuserlist>` inside msg_source — the machine-readable mention list
  //      WeChat itself attaches (authoritative; the visible name may differ from
  //      the account nickname, so text alone is not enough);
  //   2. `push_content` ("…在群聊中@了你") — the human-readable push notice;
  //   3. the raw body text, for deployments whose pushes carry neither.
  const msgSource = nestedString(record, 'msg_source', 'str') || String(record.msg_source ?? '');
  const pushContent = nestedString(record, 'push_content', 'str') || String(record.push_content ?? '');
  const atUserList = parseAtUserList(msgSource);
  const machineMentions = [...new Set([...atUserList, ...atUsers])];
  const visibleMentions = /@[^\s@\u2005]{1,64}\u2005/u.test(body);
  // When WeChat supplies ids, the list wins over the display name and push
  // notice. A missing bot id must never turn somebody else's @ into ours.
  const mentioned = Boolean(isGroup && (machineMentions.length
    ? (selfWxid ? machineMentions.includes(selfWxid) : looksLikeMentionPush(pushContent))
    : (looksLikeMentionPush(pushContent) || matchesMention(body, selfWxid, selfNickname))));
  const otherMentionOnly = Boolean(isGroup && !mentioned && (machineMentions.length || visibleMentions));

  const text = cleanupText(body);

  const message = {
    messageId,
    chatId,
    isGroup,
    senderId: senderId || fromUser,
    text: text || MEDIA_PLACEHOLDER[msgType] || '',
    msgType,
    mentioned,
    otherMentionOnly,
    contextText: isGroup && msgType === MSG_TEXT ? body.trim() : '',
    createdAt: Number(record.create_time ?? record.CreateTime ?? Date.now() / 1000) * 1000,
    rawAtUsers: atUsers,
  };
  if ([MSG_IMAGE, MSG_VOICE, MSG_VIDEO, MSG_EMOJI, MSG_APP].includes(msgType)) Object.defineProperty(message, 'mediaPayload', { value: record });
  return message;
}

/**
 * Read the mention list WeChat embeds in a group message's `msg_source`.
 *
 * The element looks like `<atuserlist>wxid_a,wxid_b</atuserlist>`; this is the
 * authoritative answer to "was the bot mentioned", unlike the visible `@name`,
 * which is the bot's per-group nickname and can differ from its account name.
 * @param {string} msgSource the raw `<msgsource>` XML.
 * @returns {string[]} mentioned wxids.
 */
export function parseAtUserList(msgSource) {
  const match = /<atuserlist>([^<]*)<\/atuserlist>/i.exec(String(msgSource ?? ''));
  if (!match) return [];
  return match[1]
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Whether WeChat's push notice says the bot was addressed in a group.
 * The notice is localized, so both the Chinese phrasing and a generic "@" form
 * are accepted; `atuserlist` remains the primary signal.
 * @param {string} pushContent the `push_content` field.
 * @returns {boolean}
 */
export function looksLikeMentionPush(pushContent) {
  const text = String(pushContent ?? '');
  if (!text) return false;
  return /在群聊中@了你/.test(text) || /@了你/.test(text) || /mentioned you/i.test(text);
}

/**
 * Whether a group body addresses this bot.
 *
 * A WeChat mention renders as `@<name>` followed by U+2005 (four-per-em space),
 * where `<name>` is the bot's nickname inside that group rather than its wxid,
 * so both are accepted. Requiring U+2005 keeps `@nick` from matching `@nickname`.
 * @param {string} body raw group body with the sender prefix already removed.
 * @param {string} selfWxid the bot's wxid, when known.
 * @param {string} selfNickname the bot's group nickname, when known.
 * @returns {boolean}
 */
export function matchesMention(body, selfWxid, selfNickname) {
  const candidates = [selfNickname, selfWxid].map((v) => String(v ?? '').trim()).filter(Boolean);
  if (candidates.length === 0) return false;
  const pattern = new RegExp(`@(?:${candidates.map(escapeRegExp).join('|')})\u2005`);
  return pattern.test(String(body ?? ''));
}

/**
 * Strip WeChat's group mention syntax (`@bot\u2005`) out of the visible text so
 * the agent receives the question, not the addressing prefix.
 */
export function cleanupText(text) {
  return String(text ?? '')
    .replace(/\u2005/g, ' ')
    .replace(/@[^\s@]{1,64}\s*/g, (match) => (match.trim() === '@' ? match : ' '))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function nestedString(record, key, field) {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const inner = value[field];
    if (typeof inner === 'string') return inner;
  }
  return '';
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide whether one decoded message should drive a session.
 * @param {ReturnType<typeof decodeMessage>} message
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {string} partnerId the bot's own wxid, when known.
 * @returns {{ allowed: boolean, reason: string, chatKey: string, senderId: string }}
 */
export function applyPolicy(message, config, partnerId) {
  if (!message) return { allowed: false, reason: 'undecodable', chatKey: '', senderId: '' };
  const self = config.selfWxid || partnerId || '';
  if (self && message.senderId === self) return { allowed: false, reason: 'self-echo', chatKey: message.chatId, senderId: message.senderId };
  if (!message.text && !message.attachments?.length) return { allowed: false, reason: 'empty', chatKey: message.chatId, senderId: message.senderId };
  if (message.msgType === MSG_SYSTEM) return { allowed: false, reason: 'system', chatKey: message.chatId, senderId: message.senderId };

  if (message.isGroup) {
    if (config.groupPolicy === 'disabled') return { allowed: false, reason: 'group-disabled', chatKey: message.chatId, senderId: message.senderId };
    if (config.groupPolicy === 'allowlist' && !matchesEntry(config.allowedGroups, message.chatId, `group:${message.chatId}`)) {
      return { allowed: false, reason: 'group-not-allowed', chatKey: message.chatId, senderId: message.senderId };
    }
    if (message.otherMentionOnly) {
      return { allowed: false, reason: 'group-other-mentioned', chatKey: message.chatId, senderId: message.senderId };
    }
    if (config.groupRequireMention && !message.mentioned) {
      return { allowed: false, reason: 'group-not-mentioned', chatKey: message.chatId, senderId: message.senderId };
    }
    return { allowed: true, reason: 'ok', chatKey: message.chatId, senderId: message.senderId };
  }

  if (config.dmPolicy === 'disabled') return { allowed: false, reason: 'dm-disabled', chatKey: message.chatId, senderId: message.senderId };
  if (config.dmPolicy === 'allowlist' && !matchesEntry(config.allowedUsers, message.senderId, `direct:${message.senderId}`)) {
    return { allowed: false, reason: 'dm-not-allowed', chatKey: message.chatId, senderId: message.senderId };
  }
  return { allowed: true, reason: 'ok', chatKey: message.chatId, senderId: message.senderId };
}

/** Match an allowlist entry against an id, its prefixed form, or the wildcard. */
export function matchesEntry(entries, id, prefixed) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.includes('*')) return true;
  return list.includes(id) || list.includes(prefixed);
}

/**
 * Split a reply into send-sized chunks, preferring paragraph then sentence
 * boundaries so a long answer does not cut mid-word.
 */
export function chunkText(text, limit) {
  const content = String(text ?? '').trim();
  if (!content) return [];
  const size = Math.max(50, Math.trunc(limit) || 1800);
  if (content.length <= size) return [content];
  const chunks = [];
  let rest = content;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('。', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Drop reasoning traces some models emit as inline tags before sending to WeChat. */
export function stripReasoning(text) {
  return String(text ?? '')
    .replace(/<\/?(?:think|thinking|thought|reasoning|analysis|scratchpad)\b[^>]*>/gi, '')
    .replace(/^\s*(?:思考|推理)[:：].*$/gm, '')
    .trim();
}
