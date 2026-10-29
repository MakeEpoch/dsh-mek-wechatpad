/**
 * Panel settings: read model, validation, and the one write path.
 *
 * dsh has two edit surfaces and this plugin supports both:
 *  - the shipped "设置 → 插件 → 可配置插件" page, which renders a form straight
 *    from this plugin's Config schema (every editable field is `volatile`) and
 *    writes it through `@deepseek-ai/dsh-settings`;
 *  - this plugin's own "设置 → 微信" page, which needs live status, a connection
 *    test, and therefore ships its own UI.
 *
 * Both persist through the profile's Cordis patch. Volatile Config updates
 * without remounting; the runtime reconciles affected connections afterward.
 * This module owns the Settings write path.
 */
import { resolveConfig, resolveDefaults } from './config.js';

/**
 * Fields the panel may write; the secrets are written but never read back.
 *
 * `provider` selects which protocol the runtime builds, so it is as editable as
 * everything else. The `weixin*` fields belong to the iLink bot; they are kept
 * editable even while provider=pad so a user can prepare the other protocol
 * before switching to it.
 */
const EDITABLE = new Set([
  'enabled', 'provider', 'enabledProviders', 'baseUrl', 'key', 'apiPrefix', 'wxid', 'receiveMode', 'webhookHost', 'webhookPath',
  'bridgeBaseUrl', 'bridgeToken', 'bridgeAccounts', 'bridgeClientId',
  'requestTimeoutSeconds', 'weixinAccountFile', 'weixinTyping', 'weixinReplyQuote', 'weixinBotType',
  'cwd', 'agentPreset', 'sessionTitlePrefix',
  'notificationProvider', 'notificationChatId', 'notifyTaskCompleted', 'notifyPermissionRequest',
  'maxReplyChunkLength', 'showProgress', 'messageMergeDelaySeconds', 'mergeReplies', 'chatOverrides', 'incomingMessageMode', 'dmPolicy', 'groupPolicy',
  'allowedUsers', 'allowedGroups', 'groupRequireMention', 'selfWxid', 'selfNickname', 'commandPrefix',
]);

/** Whether the panel is allowed to write a field. Exported for the schema test. */
export function isEditableField(field) {
  return EDITABLE.has(field);
}

export class SettingsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsUnavailableError';
    this.code = 'wechatpad/settings-unavailable';
  }
}

/**
 * Find this plugin's profile entry id. `@deepseek-ai/dsh-settings` keys forms by
 * entry id (the `id` of the bundle patch row), never by package name.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {{ ns: string, entry: object | null }}
 */
export function resolveSettingsEntry(ctx) {
  let entries = [];
  try {
    entries = ctx.get?.('configEditor')?.entries?.() ?? [];
  } catch {
    entries = [];
  }
  // Cordis may hand out a Context whose `.fiber` is a child of the entry's
  // runtime fiber, so identity alone is not enough: match on the fiber uid that
  // the Loader entry itself exposes.
  // The namespace Settings accepts is the Loader entry's `options.id` — the id
  // of the patch row. `entry.id` is the flattened include path (it reads
  // `include:wechatpad` inside a nested Include group) and is rejected with
  // `No configurable plugin entry`.
  const nsOf = (entry) => {
    const value = entry?.options?.id;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const ownUid = ctx.fiber?.uid;
  const own = entries.find((entry) => {
    if (entry?.options?.name === '@dsh/wechatpad') return true;
    if (ownUid === undefined || !entry?.fiber) return false;
    return entry.fiber === ctx.fiber || entry.fiber.uid === ownUid;
  });
  const ownNs = nsOf(own);
  if (ownNs) return { ns: ownNs, entry: own };
  const byName = entries.find((entry) => entry?.options?.name === '@dsh/wechatpad');
  const byNameNs = nsOf(byName);
  if (byNameNs) return { ns: byNameNs, entry: byName };
  // Last resort: the configured row id, which the bundle patch declares.
  return { ns: 'wechatpad', entry: null };
}

/**
 * The Settings service, or a coded error the panel can explain.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function requireSettings(ctx) {
  const settings = ctx.get?.('settings');
  if (!settings || typeof settings.update !== 'function') {
    throw new SettingsUnavailableError('dsh 的 Settings 服务未启用，无法保存设置；请改用「设置 → 插件」的配置表单。');
  }
  return settings;
}

/**
 * Describe the form once so the panel can say whether dsh agrees it is editable.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function describeSettingsEntry(ctx) {
  const { ns, entry } = resolveSettingsEntry(ctx);
  const settings = ctx.get?.('settings');
  if (!settings || typeof settings.describe !== 'function') {
    // Without the Settings service there is no form to describe, but a write
    // still fails later with an actionable error; the panel decides what it can
    // offer from `reason` rather than silently disabling every control.
    return { ns, revision: undefined, readable: false, reason: 'settings-service-missing' };
  }
  try {
    const rows = settings.describe({ redactSecrets: true }) ?? [];
    const row = rows.find((item) => item?.ns === ns);
    if (!row) {
      // The entry exists in the Loader but has no projected volatile form: the
      // Config schema is not what Settings expects, which is a plugin bug, not a
      // reason to lock the page. Report the ids we did see so it is diagnosable.
      return {
        ns,
        revision: undefined,
        readable: false,
        reason: 'entry-not-projected',
        entryFound: Boolean(entry),
        availableNs: rows.map((item) => item?.ns).filter(Boolean).slice(0, 40),
      };
    }
    return { ns, revision: row.revision, readable: true, secrets: row.secrets ?? [] };
  } catch (error) {
    return { ns, revision: undefined, readable: false, reason: 'describe-failed', message: String(error?.message ?? error) };
  }
}

/**
 * Read model for the panel: current runtime values with the secret replaced by
 * a presence flag. Reads come from the live Config, never from the patch, so
 * inherited and default values are included.
 * @param {Record<string, unknown>} config resolved runtime config.
 */
export function panelReadModel(config) {
  // The panel is fed the already-normalized runtime config, whose fields are
  // plain values; `resolveConfig` has unwrapped every volatile reference.
  // Both credentials are write-only: the page learns that one exists, never
  // what it is.
  // Ignore the removed legacy setting even if an old profile still contains it.
  const { key, bridgeToken, persistBinding: _legacyBinding, ...rest } = config ?? {};
  return {
    ...rest,
    // An old profile has no provider; the runtime default is `pad`, and the
    // panel decides which tab to open from this value, so never leave it off.
    provider: rest.provider === 'weixin' ? 'weixin' : 'pad',
    key: undefined,
    keyConfigured: Boolean(key),
    bridgeToken: undefined,
    bridgeTokenConfigured: Boolean(bridgeToken),
  };
}

/**
 * The schema defaults for the panel's `defaults` field.
 *
 * `settings.get` returns both the persisted values and this table: a profile
 * stores only what was written, so the page needs the defaults to render an
 * untouched field (the protocol switches and the iLink settings included)
 * instead of an empty control. Values are unwrapped from their volatile
 * references here because a raw `Config({})` would serialize them as `{}`.
 * @returns {Record<string, unknown>}
 */
export function panelDefaults() {
  return resolveDefaults();
}

/**
 * Validate and persist one panel edit.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} patch raw form values.
 * @param {number | undefined} expectedRevision revision the panel rendered.
 * @returns {Promise<{ saved: true, entryId: string }>}
 */
export async function savePanelSettings({ ctx, patch, expectedRevision }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('没有收到任何设置');
  }
  const settings = requireSettings(ctx);
  const { ns } = resolveSettingsEntry(ctx);
  const clean = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!EDITABLE.has(field)) continue;
    // An empty or blank secret means "leave the stored one alone" — the form
    // never echoes it back, so a blank box is not a request to clear it.
    if (['key', 'bridgeToken'].includes(field) && (value === undefined || value === null || !String(value).trim())) continue;
    clean[field] = value;
  }
  if (Object.keys(clean).length === 0) throw new TypeError('没有可保存的字段');
  // `provider` decides which protocol the next build starts; reject a typo here
  // rather than letting the Loader pick a union fallback silently.
  if ('provider' in clean && !['pad', 'weixin'].includes(clean.provider)) {
    throw new TypeError(`未知的接入方式：${String(clean.provider)}`);
  }
  if ('enabledProviders' in clean && (!Array.isArray(clean.enabledProviders) || clean.enabledProviders.some((id) => !['pad', 'weixin'].includes(id)))) throw new TypeError('无效的连接列表');
  if ('notificationProvider' in clean && !['pad', 'weixin'].includes(clean.notificationProvider)) throw new TypeError('无效的通知连接');
  if ('notificationChatId' in clean && (typeof clean.notificationChatId !== 'string' || clean.notificationChatId.length > 256)) throw new TypeError('无效的通知聊天 ID');
  for (const field of ['notifyTaskCompleted', 'notifyPermissionRequest']) {
    if (field in clean && typeof clean[field] !== 'boolean') throw new TypeError('无效的通知开关');
  }
  // Validate the merged value against the Config schema before it reaches the
  // profile, so a bad number or an unknown union member fails here with a
  // readable message instead of becoming a Loader error after the write.
  resolveConfig(clean);
  await settings.update(ns, clean, expectedRevision);
  return { saved: true, entryId: ns };
}

/**
 * Reset every editable field to its schema default.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {number | undefined} expectedRevision
 */
export async function resetPanelSettings({ ctx, expectedRevision }) {
  const settings = requireSettings(ctx);
  const { ns } = resolveSettingsEntry(ctx);
  await settings.replace(ns, {}, expectedRevision);
  return { saved: true, entryId: ns };
}

/**
 * Read the persisted form value for this plugin, as the Settings service sees
 * it in the profile patch.
 *
 * The described value includes persisted edits; connection instances may still
 * be reconciling their runtime snapshots. Read the patch for save confirmation
 * while the coordinator applies the changed values without remounting.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Record<string, unknown> | null}
 */
export function persistedFormValue(ctx) {
  const { ns } = resolveSettingsEntry(ctx);
  const settings = ctx.get?.('settings');
  if (!settings || typeof settings.describe !== 'function') return null;
  try {
    const row = (settings.describe({ redactSecrets: true }) ?? []).find((item) => item?.ns === ns);
    const value = row?.value;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
