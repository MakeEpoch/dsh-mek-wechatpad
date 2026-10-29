/**
 * WeChat Bridge outbound WebSocket subscription.
 *
 * The Bridge is a fan-out hub, not a single consumer: it delivers every inbound
 * message over BOTH its webhook target and its `/ws/outbound` server, and the
 * webhook seat is already taken by the CMS API. Subscribing here therefore does
 * not disturb that webhook; each subscriber names its own `client_id`, so the
 * dashboard and this plugin can read the same feed side by side.
 *
 * Contract (bridge/transport/outbound_ws.py):
 *   ws://<bridge>/ws/outbound?token=<token>&client_id=<id>&wxids=<a,b>
 *   frames: { type: "message", wxid, message: {...WechatPad payload...} }
 *           { type: "ping" } / { type: "pong" } / { type: "warning" | "error", ... }
 */

/** Client id this plugin registers under; distinct from the dashboard's. */
export const DEFAULT_BRIDGE_CLIENT_ID = 'dsh';

export const DEFAULT_BRIDGE_WS_PATH = '/ws/outbound';

/**
 * Build the subscription URL for one Bridge.
 * @param {object} options
 * @param {string} options.baseUrl Bridge origin, e.g. `http://127.0.0.1:8002`.
 * @param {string} options.token the `ws_server.client.token` from the Bridge config.
 * @param {string[]} options.accounts wxids to subscribe to (required by the Bridge).
 * @param {string} [options.clientId] subscriber identity.
 * @param {string} [options.wsPath] override the default path.
 * @returns {string}
 */
export function buildBridgeWsUrl({ baseUrl, token, accounts, clientId = DEFAULT_BRIDGE_CLIENT_ID, wsPath = DEFAULT_BRIDGE_WS_PATH }) {
  const list = (Array.isArray(accounts) ? accounts : []).map((item) => String(item).trim()).filter(Boolean);
  if (list.length === 0) throw new Error('Bridge 订阅需要至少一个 wxid（在设置里填机器人 wxid 列表）');
  if (!token) throw new Error('Bridge 订阅需要 ws_server.client.token');
  const wsBase = String(baseUrl ?? '').trim().replace(/\/+$/, '').replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const url = new URL(`${wsBase}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`);
  url.searchParams.set('token', token);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('wxids', list.join(','));
  return url.toString();
}

/**
 * Strip the Bridge envelope so the rest of the plugin sees a plain WechatPad
 * payload, exactly as the direct Pad push would deliver it.
 * @param {unknown} payload one decoded Bridge frame.
 * @returns {null | { wxid: string, message: unknown } | { control: string, detail?: string }}
 */
export function unwrapBridgeFrame(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const frame = /** @type {Record<string, any>} */ (payload);
  const type = String(frame.type ?? '').toLowerCase();
  if (type === 'message') {
    const wxid = String(frame.wxid ?? '').trim();
    return { wxid, message: frame.message ?? null };
  }
  if (type === 'ping') return { control: 'ping' };
  if (type === 'auth_ok' || type === 'subscribe_ok' || type === 'pong') return { control: type };
  if (type === 'warning' || type === 'error') {
    return { control: type, detail: String(frame.message ?? '') };
  }
  // A bare WechatPad payload (no envelope) is forwarded unchanged.
  if (frame.from_user_name !== undefined || frame.msg_type !== undefined) return { wxid: '', message: frame };
  return { control: 'unknown' };
}

/**
 * Whether a wxid should be subscribed given the configured account list and the
 * bot's own id. The Bridge requires the explicit list, so the plugin derives it
 * from config instead of asking the user twice.
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @returns {string[]}
 */
export function bridgeAccounts(config) {
  const explicit = parseAccounts(config.bridgeAccounts);
  if (explicit.length > 0) return explicit;
  const self = String(config.selfWxid ?? '').trim();
  return self ? [self] : [];
}

/** Split a comma/whitespace separated account list. */
export function parseAccounts(raw) {
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  return String(raw ?? '')
    .split(/[,，\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Extract distinct group chatroom ids from a WeChat Bridge log tail.
 *
 * The Bridge logs every inbound payload verbatim, so its log is the only
 * historical record of which groups exist once the plugin's in-memory
 * inventory is lost to a restart. Each row carries the last time that group
 * spoke, which is what an operator actually uses to tell one numeric chatroom
 * id from another.
 *
 * The log is SHARED by every account the Bridge serves, and each line names the
 * account it belongs to (`wxid=<account>`). Parsing without that filter reports
 * groups belonging to other bots — so `accounts` is required and a line whose
 * account is not listed is skipped.
 *
 * This is a best-effort parse of an operational log, never an authority: a
 * missing or unreadable log simply yields no rows.
 *
 * @param {string} text raw log text.
 * @param {{ accounts?: string[], limit?: number }} [options]
 * @returns {Array<{ chatId: string, count: number, lastAt: number, sample: string }>}
 */
export function groupsFromBridgeLog(text, options = {}) {
  const accounts = new Set((options.accounts ?? []).map((item) => String(item).trim()).filter(Boolean));
  const limit = Number.isInteger(options.limit) ? options.limit : 50;
  if (accounts.size === 0) return [];

  const seen = new Map();
  const accountPattern = /\bwxid=([^\s]+)/;
  const groupPattern = /"from_user_name":\s*\{\s*"str":\s*"([^"]*@chatroom)"/g;
  const textPattern = /"content":\s*\{\s*"str":\s*"((?:[^"\\]|\\.)*)"/;
  for (const line of String(text ?? '').split('\n')) {
    const account = accountPattern.exec(line)?.[1];
    if (!account || !accounts.has(account)) continue;
    const stamp = parseLogTime(line);
    for (const match of line.matchAll(groupPattern)) {
      const chatId = match[1];
      const row = seen.get(chatId) ?? { chatId, count: 0, lastAt: 0, sample: '' };
      row.count += 1;
      if (stamp !== null && stamp > row.lastAt) row.lastAt = stamp;
      if (!row.sample) {
        const body = textPattern.exec(line);
        if (body) row.sample = decodeLogText(body[1]).slice(0, 40);
      }
      seen.set(chatId, row);
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.lastAt - a.lastAt || b.count - a.count)
    .slice(0, limit);
}

/** Parse the `YYYY-MM-DD HH:MM:SS,mmm` prefix the Bridge logger writes. */
export function parseLogTime(line) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/.exec(String(line ?? ''));
  if (!match) return null;
  const [, y, mo, d, h, mi, sec, ms] = match;
  // The Bridge logs in the host's local zone; Date parses it the same way.
  const value = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}${ms ? `.${ms.padEnd(3, '0')}` : ''}`);
  return Number.isNaN(value.getTime()) ? null : value.getTime();
}

/** Undo JSON string escaping inside a captured log field. */
function decodeLogText(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}
