/**
 * Connection selection: which protocol this profile speaks.
 *
 * `createConnection(config)` is the only place that knows protocol module
 * names. The Pad adapter is part of this package; the iLink (weixin) adapter is
 * a separate file that may be absent or broken, so it is imported dynamically
 * and every load can fail closed:
 *
 *   - an unknown `provider` yields a connection that reports the problem in
 *     `status().lastError` and does nothing else;
 *   - a weixin adapter that cannot be imported yields the same, with the import
 *     error recorded;
 *   - an adapter whose factory throws or returns something that is not a
 *     connection yields the same.
 *
 * `createConnection` therefore never throws: a broken optional protocol must
 * never take `apply()` — and with it the Settings panel — down. The default
 * provider is `pad`, so profiles written before this field existed keep the
 * exact runtime they had.
 */
import {
  CONNECTION_IDS, DEFAULT_CAPABILITIES, DEFAULT_PROVIDER, UNAVAILABLE_PROVIDER_ERROR,
  assertConnection, normalizeCapabilities, unsupportedFeature,
} from './types.js';
import { createPadConnection } from './pad.js';

/** Factories for the adapters this package ships. */
const STATIC_FACTORIES = Object.freeze({
  pad: (options) => createPadConnection(options),
});

/** Module used for a provider that is not bundled with this package. */
const DYNAMIC_FACTORIES = Object.freeze({
  weixin: { module: './weixin.js', export: 'createWeixinConnection' },
});

/**
 * Resolve the provider for a configuration. A profile that predates the field
 * (or carries a blank value) is a Pad profile.
 * @param {Record<string, unknown> | undefined} config resolved Config.
 * @returns {string}
 */
export function resolveProvider(config) {
  const value = String(config?.provider ?? '').trim().toLowerCase();
  return value || DEFAULT_PROVIDER;
}

/**
 * Pick the connection for a configuration. Never throws.
 * @param {Record<string, any>} config resolved Config (`resolveConfig` output).
 * @param {object} [options]
 * @param {import('@deepseek-ai/cordis').Context} [options.ctx] plugin Context.
 * @param {(level: string, msg: string) => void} [options.logger]
 * @param {string} [options.webhookToken] token the Pad presents on the webhook.
 * @param {(spec: { provider: string, module: string, export: string }) => Promise<any>} [options.load]
 *   override the dynamic importer (tests inject a fake adapter).
 * @returns {Promise<import('./types.js').WechatConnection>}
 */
export async function createConnection(config, options = {}) {
  const provider = resolveProvider(config);
  const factoryOptions = {
    ctx: options.ctx,
    config,
    logger: options.logger,
    webhookToken: options.webhookToken,
    provider,
  };

  try {
    if (Object.hasOwn(STATIC_FACTORIES, provider)) {
      return assertConnection(STATIC_FACTORIES[provider](factoryOptions), `${provider} 连接`);
    }
    const spec = DYNAMIC_FACTORIES[provider];
    if (!spec) {
      return unavailableConnection(provider, `未知的 provider「${provider}」，可选：${CONNECTION_IDS.join(' / ')}`);
    }
    const factory = await loadFactory(spec, options.load);
    return assertConnection(factory(factoryOptions), `${provider} 连接`);
  } catch (error) {
    const detail = String(error?.message ?? error);
    options.logger?.('error', `${provider} 连接不可用：${detail}`);
    return unavailableConnection(provider, detail);
  }
}

/**
 * Import one adapter module and return its factory.
 * @param {{ module: string, export: string }} spec
 * @param {((spec: any) => Promise<any>) | undefined} load
 */
async function loadFactory(spec, load) {
  const loaded = load ? await load(spec) : await import(spec.module);
  const factory = loaded?.[spec.export] ?? loaded?.default;
  if (typeof factory !== 'function') {
    throw new Error(`${spec.module} 未导出 ${spec.export}`);
  }
  return factory;
}

/**
 * A connection that stands in for one that cannot be created.
 *
 * It keeps the contract (so callers need no special case) and records why it is
 * useless in `status().lastError`, which the panel shows. `start()` reports the
 * failure through `onState` instead of rejecting, so the service's teardown and
 * settings page still behave.
 * @param {string} provider requested provider id.
 * @param {string} detail why it is unavailable.
 * @returns {import('./types.js').WechatConnection & { unavailable: true, reason: string }}
 */
export function unavailableConnection(provider, detail) {
  const reason = detail || UNAVAILABLE_PROVIDER_ERROR;
  return {
    id: CONNECTION_IDS.includes(provider) ? provider : (provider || 'pad'),
    label: provider === 'weixin' ? '微信机器人（不可用）' : 'WechatPad（不可用）',
    unavailable: true,
    reason,
    capabilities: { ...normalizeCapabilities(DEFAULT_CAPABILITIES) },
    async start(handlers) {
      try {
        handlers?.onState?.({ phase: 'error', error: `${UNAVAILABLE_PROVIDER_ERROR}：${reason}` });
      } catch {
        /* a broken handler must not turn an unavailable adapter into a throw */
      }
    },
    async stop() {},
    async send() {
      return { ok: false, delivered: 0, error: `${UNAVAILABLE_PROVIDER_ERROR}：${reason}` };
    },
    async typing() {
      return false;
    },
    async beginLogin() {
      return unsupportedFeature(reason);
    },
    async pollLogin() {
      return unsupportedFeature(reason);
    },
    async cancelLogin() {
      return unsupportedFeature(reason);
    },
    async resetAccount() {
      return unsupportedFeature(reason);
    },
    status() {
      return {
        provider,
        connected: false,
        lastError: reason,
        unavailable: true,
        capabilities: { ...normalizeCapabilities(DEFAULT_CAPABILITIES) },
      };
    },
    async test() {
      return { ok: false, detail: UNAVAILABLE_PROVIDER_ERROR, error: reason };
    },
  };
}

export { CONNECTION_IDS, DEFAULT_CAPABILITIES, DEFAULT_PROVIDER, UNAVAILABLE_PROVIDER_ERROR };
export {
  OPTIONAL_MEMBERS, REQUIRED_MEMBERS, assertConnection, isConnection, normalizeCapabilities,
  safeSend, unsupportedFeature,
} from './types.js';
export { PadConnection, createPadConnection } from './pad.js';
