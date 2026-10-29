/**
 * Plugin Config schema and its normalizer.
 *
 * Every field a user may edit from the dsh Settings panel is declared
 * `volatile`: the `@deepseek-ai/dsh-settings` service only projects fields
 * underneath a `volatile` node into an editable form, and every other field
 * keeps the usual "edit the Cordis file and remount" lifecycle. Secrets are
 * declared `role('secret')` so the Settings controller never returns their
 * value across the wire — only whether one is currently stored.
 *
 * The schema is built from the host's own `@deepseek-ai/schemastery` instance
 * so `SettingsForms` recognizes it (`"toJSON" in entry.fiber.runtime.Config`).
 */
import z from '@deepseek-ai/schemastery';

export const RECEIVE_MODES = ['websocket', 'webhook', 'bridge'];
export const DM_POLICIES = ['open', 'allowlist', 'disabled'];
export const GROUP_POLICIES = ['open', 'allowlist', 'disabled'];
/**
 * How WeChat reaches dsh.
 *  - `pad`: WechatPad, either direct (Pad API + key) or through WeChat Bridge.
 *  - `weixin`: the Tencent iLink bot bound by scanning a QR code; no Pad at all.
 * The list is the schema's union and the normalizer's fallback table in one
 * place, so an unknown value written by an older profile lands on `pad` — the
 * behaviour every existing profile already had.
 */
export const PROVIDERS = ['pad', 'weixin'];
export const DEFAULT_PROVIDER = 'pad';

// Two independent marks are needed, and order matters: `role()` REPLACES the whole
// meta while `extra()` merges into it. So the chain is always
//   .role('volatile')            -> serialized meta the Settings form reads
//   .extra('volatile', true)   -> the runtime value becomes a live reference
// (dsh reads it through `.get()`), which is what keeps parsed Config values plain).
const listOfStrings = (label) => z.array(z.string()).default([]).description(label).role('volatile').extra('volatile', true);

export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('关闭后在运行时断开微信、停止收发，但保留全部配置。')
    .role('volatile').extra('volatile', true),

  // ── 接入方式 ────────────────────────────────────────────────────────────
  // Declared first on purpose: the panel groups every later field under the tab
  // this one selects, and an old profile that never set it reads as `pad`.
  provider: z
    .union([z.const('pad'), z.const('weixin')])
    .default(DEFAULT_PROVIDER)
    .description('微信接入方式。WechatPad：直连 Pad / WeChat Bridge；微信机器人：扫码绑定腾讯 iLink 机器人，无需 Pad。')
    .role('volatile').extra('volatile', true),

  enabledProviders: z.array(z.union([z.const('pad'), z.const('weixin')])).default(undefined)
    .description('独立启用的微信连接，可同时启用 Pad 和扫码机器人。空列表表示全部关闭；旧配置自动沿用 provider。')
    .role('volatile').extra('volatile', true),

  // ── 连接 ────────────────────────────────────────────────────────────────
  baseUrl: z
    .string()
    .default('http://127.0.0.1:8059')
    .description('直连 WechatPad 的服务地址，例如 http://127.0.0.1:8059。Bridge 接入请填写 bridgeBaseUrl。')
    .role('volatile').extra('volatile', true),
  // A secret is marked with `role('secret')`; its serialized meta is widened to
  // add the `volatile` flag below, because `role()` overwrites instead of merging.
  // A secret carries `role('secret')` for redaction; its serialized meta also
  // gains `volatile` from the same toJSON widening as every other field.
  key: z
    .string()
    .role('secret')
    .extra('volatile', true)
    .description('直连 WechatPad 的 key。Bridge 接入由 Bridge 注入账号凭证，无需填写此项。写入后设置页不再回显。'),
  apiPrefix: z
    .string()
    .default('')
    .description('兼容旧版代理配置的接口前缀。新配置保持留空；Bridge 接入使用 receiveMode=bridge。')
    .role('volatile').extra('volatile', true),
  wxid: z
    .string()
    .default('')
    .description('兼容旧版配置的机器人 wxid；新 Bridge 配置使用 bridgeAccounts。')
    .role('volatile').extra('volatile', true),
  receiveMode: z
    .union([z.const('websocket'), z.const('webhook'), z.const('bridge')])
    .default('websocket')
    .description('websocket：直连 WechatPad 的 /ws/GetSyncMsg；webhook：WechatPad 回调到本机端口；bridge：订阅 WeChat Bridge 的 /ws/outbound（与 webhook 分发并行，不影响其他消费者）。')
    .role('volatile').extra('volatile', true),
  webhookHost: z
    .string()
    .default('127.0.0.1')
    .description('webhook 模式监听地址。')
    .role('volatile').extra('volatile', true),
  bridgeBaseUrl: z
    .string()
    .default('')
    .description('WeChat Bridge 服务地址，例如 http://127.0.0.1:8002；Bridge 接入时必填。')
    .role('volatile').extra('volatile', true),
  bridgeToken: z
    .string()
    .role('secret')
    .extra('volatile', true)
    .description('Bridge 的 ws_server.client.token；只写不读。'),
  bridgeAccounts: z
    .string()
    .default('')
    .description('Bridge 订阅的 wxid 列表（逗号分隔）；留空则使用上面的机器人 wxid。')
    .role('volatile').extra('volatile', true),
  bridgeClientId: z
    .string()
    .default('dsh')
    .description('Bridge 客户端身份；同一 Bridge 上每个消费者用不同值，避免互相顶掉。')
    .role('volatile').extra('volatile', true),
  webhookPath: z
    .string()
    .default('/wechatpad/callback')
    .description('webhook 模式回调路径。')
    .role('volatile').extra('volatile', true),
  requestTimeoutSeconds: z
    .number()
    .min(5)
    .max(120)
    .default(20)
    .description('单次 HTTP 请求超时（秒）。')
    .role('volatile').extra('volatile', true),

  // ── 微信机器人（腾讯 iLink，provider=weixin） ────────────────────────────
  // These only matter when `provider` is 'weixin'. They stay declared for every
  // profile so switching provider back and forth never loses them, and so the
  // panel can render the tab's defaults before the first save.
  //
  // The iLink access token is deliberately NOT a config field: it is obtained
  // by scanning, written by the Host to the account file below, and never
  // crosses the settings RPC. Only `key` and `bridgeToken` stay secrets.
  weixinAccountFile: z
    .string()
    .default('')
    .description('微信机器人账号数据文件的存放目录（只读提示）。留空使用 ~/.dsh/wechatpad/weixin-accounts；登录凭证由插件写入该目录，不保存在设置里。')
    .role('volatile').extra('volatile', true),
  weixinTyping: z
    .boolean()
    .default(true)
    .description('处理消息期间向微信显示「正在输入」。')
    .role('volatile').extra('volatile', true),
  weixinReplyQuote: z
    .boolean()
    .default(true)
    .description('微信用户引用消息时，把被引用的内容一并交给模型。')
    .role('volatile').extra('volatile', true),
  weixinBotType: z
    .string()
    .default('3')
    .description('扫码绑定的机器人类型。普通用户请勿修改。')
    .role('volatile').extra('volatile', true),

  notificationProvider: z.union([z.const('pad'), z.const('weixin')]).default('weixin')
    .description('全局通知使用的微信连接；该连接须已启用。').role('volatile').extra('volatile', true),
  notificationChatId: z.string().default('')
    .description('所有会话通知的接收聊天 ID。留空不发送；扫码机器人须先收到该微信发来的消息。').role('volatile').extra('volatile', true),
  notifyTaskCompleted: z.boolean().default(false)
    .description('所有会话的任务正常完成时发送单向通知。').role('volatile').extra('volatile', true),
  notifyPermissionRequest: z.boolean().default(false)
    .description('所有会话请求权限时发送单向提醒；仍在 DSH 桌面或网页处理。').role('volatile').extra('volatile', true),

  // ── 会话 ────────────────────────────────────────────────────────────────
  cwd: z
    .string()
    .default('')
    .description('新会话的通用工作目录；留空时按聊天使用 ~/.dsh/wechat/<chatId>。')
    .role('volatile').extra('volatile', true),
  agentPreset: z
    .string()
    .default('')
    .description('新会话使用的 Agent Preset；留空使用 dsh 默认。')
    .role('volatile').extra('volatile', true),
  sessionTitlePrefix: z
    .string()
    .default('微信')
    .description('会话标题前缀，便于在 dsh 会话列表中辨认来源。')
    .role('volatile').extra('volatile', true),
  maxReplyChunkLength: z
    .number()
    .min(100)
    .max(4000)
    .default(1800)
    .description('单条回复的最大字数，超出自动分段。')
    .role('volatile').extra('volatile', true),
  showProgress: z
    .boolean()
    .default(true)
    .description('运行中把工具调用进度作为一条可编辑状态发回微信（失败时静默降级为不发）。')
    .role('volatile').extra('volatile', true),
  messageMergeDelaySeconds: z
    .number().min(0).max(30).default(0)
    .description('消息合并等待时间（秒）：同一聊天同一发送者停止发消息后等待此时长，再合并提交；0 表示立即处理。提问回答和控制命令即时处理。')
    .role('volatile').extra('volatile', true),
  mergeReplies: z.boolean().default(false)
    .description('把一轮 DSH 回复的多段文本等到完成后合并发到微信；超过单条字数限制仍会分段。')
    .role('volatile').extra('volatile', true),
  chatOverrides: z.array(z.object({
    provider: z.union([z.const('pad'), z.const('weixin')]),
    chatId: z.string(),
    cwd: z.string().default('inherit'),
    mergeReplies: z.union([z.const('inherit'), z.boolean()]).default('inherit'),
    maxReplyChunkLength: z.union([z.const('inherit'), z.number().min(100).max(4000)]).default('inherit'),
    showProgress: z.union([z.const('inherit'), z.boolean()]).default('inherit'),
    messageMergeDelaySeconds: z.union([z.const('inherit'), z.number().min(0).max(30)]).default('inherit'),
    incomingMessageMode: z.union([z.const('inherit'), z.const('queue'), z.const('interrupt')]).default('inherit'),
  })).default([])
    .description('按微信聊天覆盖会话设置；inherit 表示跟随通用设置。')
    .role('volatile').extra('volatile', true),
  incomingMessageMode: z
    .union([z.const('queue'), z.const('interrupt')]).default('queue')
    .description('新消息处理：queue 等当前任务结束后处理；interrupt 停止当前任务，再提交新消息，已排队的消息保留。')
    .role('volatile').extra('volatile', true),

  // ── 访问控制 ────────────────────────────────────────────────────────────
  dmPolicy: z
    .union([z.const('open'), z.const('allowlist'), z.const('disabled')])
    .default('allowlist')
    .description('私聊策略：open 全部响应；allowlist 仅响应白名单；disabled 忽略私聊。')
    .role('volatile').extra('volatile', true),
  groupPolicy: z
    .union([z.const('open'), z.const('allowlist'), z.const('disabled')])
    .default('disabled')
    .description('群聊策略：open 响应所有群；allowlist 仅响应群白名单；disabled 忽略群聊。')
    .role('volatile').extra('volatile', true),
  allowedUsers: listOfStrings('私聊白名单：允许的发送者 wxid，可用逗号分隔。'),
  allowedGroups: listOfStrings('群白名单：允许的群 chatroom id（xxx@chatroom），可用逗号分隔。'),
  groupRequireMention: z
    .boolean()
    .default(true)
    .description('群聊中只有被 @ 时才驱动会话。')
    .role('volatile').extra('volatile', true),
  selfNickname: z
    .string()
    .default('')
    .description('机器人在群里的昵称。群里 @ 的是昵称而不是 wxid，留空则自动从 Bridge 查询。')
    .role('volatile').extra('volatile', true),
  selfWxid: z
    .string()
    .default('')
    .description('机器人自己的 wxid，用于忽略自己发出的消息回声；留空自动识别。')
    .role('volatile').extra('volatile', true),
  commandPrefix: z
    .string()
    .default('/')
    .description('控制命令前缀，支持 /new /stop /status。')
    .role('volatile').extra('volatile', true),
});

/**
 * Give the secret field both flags in the serialized schema.
 *
 * `@deepseek-ai/dsh-settings` reads two independent things off a schema node's
 * meta: `volatile` decides whether the field may appear in an editable form at
 * all, and `role === 'secret'` decides whether its value is stripped before a
 * describe/update crosses the wire. `role()` overwrites the whole role, so it
 * cannot set both; `extra()` writes into `meta.extra` instead. The one seam
 * that copies a node's meta verbatim is `toJSON`, so that is where the two are
 * merged — and the merge is applied to every serialization, so a describe call
 * after any other form has been read still sees the secret treatment.
 *
 * The override must stay non-enumerable: the stock `toJSON` spreads the schema
 * object itself, so an enumerable replacement would be serialized into the
 * node and the whole tree would collapse to `{"uid": n}`.
 */
const serialize = Config.toJSON.bind(Config);
Object.defineProperty(Config, 'toJSON', {
  value: function toJSONWithSecretRole() {
    const json = serialize();
    const refs = json?.refs ?? {};
    const root = refs[json?.uid];
    const keyId = root?.dict?.key;
    const node = keyId === undefined ? undefined : refs[keyId];
    if (node && node.meta) node.meta = { ...node.meta, role: 'secret', volatile: true };
    return json;
  },
  writable: true,
  configurable: true,
  enumerable: false,
});

/** Fields whose value must never be echoed back to a browser. */
export const SECRET_FIELDS = Object.freeze(['key']);

/**
 * Read one field out of a parsed Config.
 *
 * A `volatile` field arrives as a live reference that dsh updates in place when
 * a setting is written; a plain field arrives as its value. Reading both the
 * same way is what makes a settings change actually reach the running bridge.
 * @param {Record<string, unknown>} value parsed Config.
 * @param {string} field field name.
 */
export function readField(value, field) {
  const entry = value?.[field];
  if (entry !== null && typeof entry === 'object' && typeof entry.get === 'function') return entry.get();
  return entry;
}

/**
 * Normalize a parsed Config value into the plain shape the runtime consumes.
 * Loader hands plugins the parsed output, but a hand-written patch row or an
 * older profile may omit fields, so every consumer reads through this.
 * @param {Record<string, unknown> | undefined} raw parsed Config (or undefined).
 * @returns {Record<string, any>} fully populated configuration.
 */
export function resolveConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const { field, strings } = readFields(value);
  const trimmedBase = String(field('baseUrl') ?? '').trim().replace(/\/+$/, '');
  return {
    enabled: field('enabled') !== false,
    // An unknown value (a hand-edited patch, a profile written by a newer
    // version that added a third protocol) falls back to the historical pad
    // behaviour rather than leaving the runtime with no adapter at all.
    provider: PROVIDERS.includes(field('provider')) ? field('provider') : DEFAULT_PROVIDER,
    enabledProviders: Array.isArray(field('enabledProviders')) ? [...new Set(field('enabledProviders').filter((id) => PROVIDERS.includes(id)))] : [PROVIDERS.includes(field('provider')) ? field('provider') : DEFAULT_PROVIDER],
    baseUrl: trimmedBase || 'http://127.0.0.1:8059',
    key: String(field('key') ?? '').trim(),
    apiPrefix: normalizePrefix(field('apiPrefix')),
    wxid: String(field('wxid') ?? '').trim(),
    receiveMode: RECEIVE_MODES.includes(field('receiveMode')) ? field('receiveMode') : 'websocket',
    bridgeBaseUrl: String(field('bridgeBaseUrl') ?? '').trim().replace(/\/+$/, ''),
    bridgeToken: String(field('bridgeToken') ?? '').trim(),
    bridgeAccounts: String(field('bridgeAccounts') ?? '').trim(),
    bridgeClientId: String(field('bridgeClientId') ?? '').trim() || 'dsh',
    webhookHost: String(field('webhookHost') ?? '127.0.0.1').trim() || '127.0.0.1',
    webhookPath: ensureLeadingSlash(String(field('webhookPath') ?? '/wechatpad/callback').trim()),
    requestTimeoutSeconds: clampNumber(field('requestTimeoutSeconds'), 5, 120, 20),
    // iLink bot: a directory hint only (empty = the Host picks the default
    // under ~/.dsh), two behaviour switches read optimistically as `!== false`,
    // and the bot type kept as a string because iLink treats it as an opaque id.
    weixinAccountFile: String(field('weixinAccountFile') ?? '').trim(),
    weixinTyping: field('weixinTyping') !== false,
    weixinReplyQuote: field('weixinReplyQuote') !== false,
    weixinBotType: String(field('weixinBotType') ?? '').trim() || '3',
    cwd: String(field('cwd') ?? '').trim(),
    notificationProvider: field('notificationProvider') === 'pad' ? 'pad' : 'weixin',
    notificationChatId: String(field('notificationChatId') ?? '').trim(),
    notifyTaskCompleted: field('notifyTaskCompleted') === true,
    notifyPermissionRequest: field('notifyPermissionRequest') === true,
    agentPreset: String(field('agentPreset') ?? '').trim(),
    sessionTitlePrefix: String(field('sessionTitlePrefix') ?? '').trim(),
    maxReplyChunkLength: Math.trunc(clampNumber(field('maxReplyChunkLength'), 100, 4000, 1800)),
    showProgress: field('showProgress') !== false,
    messageMergeDelaySeconds: clampNumber(field('messageMergeDelaySeconds'), 0, 30, 0),
    mergeReplies: field('mergeReplies') === true,
    chatOverrides: normalizeChatOverrides(field('chatOverrides')),
    incomingMessageMode: field('incomingMessageMode') === 'interrupt' ? 'interrupt' : 'queue',
    dmPolicy: DM_POLICIES.includes(field('dmPolicy')) ? field('dmPolicy') : 'allowlist',
    groupPolicy: GROUP_POLICIES.includes(field('groupPolicy')) ? field('groupPolicy') : 'disabled',
    allowedUsers: strings(field('allowedUsers')),
    allowedGroups: strings(field('allowedGroups')),
    groupRequireMention: field('groupRequireMention') !== false,
    selfNickname: String(field('selfNickname') ?? '').trim(),
    selfWxid: String(field('selfWxid') ?? '').trim(),
    commandPrefix: String(field('commandPrefix') ?? '/').trim() || '/',
  };
}

/**
 * Field readers shared by `resolveConfig` and `resolveDefaults`.
 *
 * Both must read a volatile field through `.get()`: a number or boolean field
 * arrives as an opaque frozen reference, so a table built from raw
 * `Config({})` values would hand the panel `{}` instead of `20` and render an
 * empty input.
 * @param {Record<string, unknown>} value parsed Config (or any patch object).
 */
function readFields(value) {
  return {
    field: (name) => readField(value, name),
    strings: (input) => {
      if (Array.isArray(input)) return input.map((item) => String(item).trim()).filter(Boolean);
      if (typeof input === 'string') return splitList(input);
      return [];
    },
  };
}

/**
 * The schema defaults as the panel needs them.
 *
 * The Settings form renders an untouched field from the value the profile
 * stores, and a profile stores only what was written. The page therefore shows
 * `defaults[field]` for every field the read model left out; without the
 * unwrap below a schema default would arrive as a volatile reference object.
 * @returns {Record<string, any>} every declared field at its schema default.
 */
export function resolveDefaults() {
  const { field, strings } = readFields(Config({}));
  const defaults = {};
  for (const name of Object.keys(Config.dict ?? {})) {
    defaults[name] = field(name);
  }
  // Lists arrive as arrays; the page edits them as comma separated text through
  // `settings.allowedUsers`, so expose the same shape `resolveConfig` does.
  defaults.allowedUsers = strings(field('allowedUsers'));
  defaults.allowedGroups = strings(field('allowedGroups'));
  // Keep the table plain: it crosses the settings RPC as JSON, and a nested
  // reference object would serialize as `{}`.
  return JSON.parse(JSON.stringify(defaults));
}

/** Split a comma/whitespace separated list, tolerating full-width commas. */
export function splitList(input) {
  return String(input ?? '')
    .split(/[,，\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const CHAT_FIELDS = ['cwd', 'mergeReplies', 'maxReplyChunkLength', 'showProgress', 'messageMergeDelaySeconds', 'incomingMessageMode'];

function normalizeChatOverrides(input) {
  const rows = new Map();
  for (const item of Array.isArray(input) ? input.slice(0, 500) : []) {
    if (!item || !PROVIDERS.includes(item.provider)) continue;
    const chatId = String(item.chatId ?? '').trim();
    if (!chatId || chatId.length > 256) continue;
    const row = { provider: item.provider, chatId };
    for (const field of CHAT_FIELDS) {
      const value = item[field];
      if (value === undefined || value === 'inherit') continue;
      if (field === 'cwd' && typeof value === 'string' && value.trim()) row[field] = value.trim();
      if (['mergeReplies', 'showProgress'].includes(field) && typeof value === 'boolean') row[field] = value;
      if (field === 'maxReplyChunkLength' && Number.isFinite(value) && value >= 100 && value <= 4000) row[field] = Math.trunc(value);
      if (field === 'messageMergeDelaySeconds' && Number.isFinite(value) && value >= 0 && value <= 30) row[field] = value;
      if (field === 'incomingMessageMode' && ['queue', 'interrupt'].includes(value)) row[field] = value;
    }
    if (Object.keys(row).length > 2) rows.set(JSON.stringify([row.provider, row.chatId]), row);
  }
  return [...rows.values()];
}

/** Apply only this chat's explicitly set fields; absent values follow general settings. */
export function chatSettingsFor(config, provider, chatId) {
  const row = config.chatOverrides?.find((item) => item.provider === provider && item.chatId === chatId);
  if (!row) return config;
  const settings = { ...config };
  for (const field of CHAT_FIELDS) if (row[field] !== undefined) settings[field] = row[field];
  return settings;
}

function normalizePrefix(input) {
  const raw = String(input ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function ensureLeadingSlash(input) {
  if (!input) return '/';
  return input.startsWith('/') ? input : `/${input}`;
}

function clampNumber(input, min, max, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve how OUTBOUND calls reach WechatPad for a given configuration.
 *
 * WeChat Bridge proxies every Pad endpoint under `/proxy/{wxid}/...` and injects
 * the account's own `auth_key`, so bridge mode needs no Pad address and no key:
 * one Bridge origin plus the bot wxid is enough. Direct mode uses the Pad
 * origin and its key.
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {{ baseUrl: string, key: string, apiPrefix: string, wxid: string, configured: boolean }}
 */
export function outboundTarget(config) {
  if (config.receiveMode === 'bridge') {
    const baseUrl = config.bridgeBaseUrl;
    const wxid = config.wxid || firstAccount(config.bridgeAccounts);
    return {
      baseUrl,
      // The Bridge fills in the auth_key; sending carries no separate credential.
      key: '',
      apiPrefix: '/proxy',
      wxid,
      configured: Boolean(baseUrl && wxid),
    };
  }
  return {
    baseUrl: config.baseUrl,
    key: config.key,
    apiPrefix: config.apiPrefix,
    wxid: config.wxid,
    configured: Boolean(config.baseUrl && config.key && (!config.apiPrefix || config.wxid)),
  };
}

/** First entry of a comma/space separated account list. */
export function firstAccount(raw) {
  return String(raw ?? '').split(/[,，\s]+/).map((part) => part.trim()).filter(Boolean)[0] ?? '';
}
