/**
 * dsh host entry: `@dsh/wechatpad`.
 *
 * Cordis semantics this plugin relies on:
 *  - `Config` is read by the Settings service, so every user-editable field is
 *    `volatile` and every secret is `role('secret')`;
 *  - a Settings write updates volatile Config without remounting; the service
 *    reconciles enabled channels and transport changes after persistence;
 *  - `ctx.effect` gives the runtime one teardown path for every exit — disable,
 *    config edit, or dsh shutdown.
 *
 * The host needs no HTTP port of its own: `ctx.webServer` routes and
 * `ctx.connection` carry both the WeChat side and the Settings panel.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { Config, resolveConfig } from './config.js';
import { registerManagementRpc } from './management-rpc.js';
import {
  describeSettingsEntry, panelReadModel, persistedFormValue, resetPanelSettings, savePanelSettings,
} from './settings-bridge.js';
import { WechatPadService } from './wechatpad-service.js';
import { installOutboundArtifactTool } from './vendor/artifact.js';

export const name = 'dsh-wechatpad';

/**
 * Services the Host half needs before it may start. `connection` provides the
 * owner Peer and the RPC carrier; `webServer` hosts the push/webhook routes;
 * `typertGateway` is the in-process Remote transport into the Session domain.
 * `settings` and `configEditor` stay optional (`ctx.get`), so a minimal
 * composition still runs with the settings page degraded.
 */
export const inject = ['connection', 'webServer', 'typertGateway'];

export { Config };

/**
 * Mount the WeChat bridge.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin Context.
 * @param {Record<string, unknown>} raw parsed Config.
 */
export function apply(ctx, raw) {
  // dsh already ran this Config schema: `raw` is the parsed output, whose
  // fields are live `volatile` references. Parsing it a second time throws
  // (volatile schemas reject an enclosing volatile path), so keep it as-is and
  // let `resolveConfig` unwrap the references where values are needed.
  const config = raw && typeof raw === 'object' ? raw : Config({});
  const logger = makeLogger(ctx);
  // Register on the actual Agent scope; Host services may not exist here.
  installOutboundArtifactTool(ctx, { onRegistered: (sessionId) => logger('info', `微信附件工具及指导已挂载：${sessionId}`) });

  let service = null;

  ctx.effect(() => {
    const start = async () => {
      service = new WechatPadService({ ctx, config, logger });
      await service.start();
    };
    // A failed start must not take the plugin (and its settings page) down: the
    // panel is how a user fixes a wrong key or address.
    start().catch((error) => logger('error', `启动失败：${error?.message ?? error}`));

    // The settings page answers even when WeChat cannot connect — that is
    // exactly when a user opens it — so its RPC goes through a facade that
    // falls back to Config + Settings until the service exists.
    const panel = new PanelFacade({ ctx, config, getService: () => service });
    let stopRpc = null;
    registerManagementRpc({ ctx, service: panel, logger })
      .then((dispose) => { stopRpc = dispose; })
      .catch((error) => logger('error', `设置面板接口注册失败：${error?.message ?? error}`));

    return async () => {
      await stopRpc?.();
      await service?.dispose();
      service = null;
    };
  }, 'wechatpad: WeChat bridge');
}

/**
 * Settings-page operations. Each delegates to the live service when it exists
 * and otherwise works from Config and the Settings service alone.
 */
class PanelFacade {
  #ctx;
  #config;
  #getService;

  constructor({ ctx, config, getService }) {
    this.#ctx = ctx;
    this.#config = resolveConfig(config);
    this.#getService = getService;
  }

  status() {
    const service = this.#getService();
    if (service) return service.status();
    return {
      phase: this.#config.enabled ? 'starting' : 'disabled',
      label: this.#config.enabled ? '启动中' : '已关闭',
      since: Date.now(),
      lastError: '',
      receiveMode: this.#config.receiveMode,
      baseUrl: this.#config.baseUrl,
      messagesIn: 0,
      messagesOut: 0,
      webhookUrl: '',
      connected: false,
      keyConfigured: Boolean(this.#config.key),
    };
  }

  panelSettings() {
    const service = this.#getService();
    if (service) return service.panelSettings();
    const descriptor = describeSettingsEntry(this.#ctx);
    const persisted = persistedFormValue(this.#ctx);
    const merged = persisted ? { ...this.#config, ...persisted } : this.#config;
    return {
      settings: panelReadModel(merged),
      defaults: resolveConfig({}),
      entryId: descriptor.ns,
      revision: descriptor.revision,
      readable: descriptor.readable,
      reason: descriptor.reason,
    };
  }

  async updateSettings(patch, expectedRevision) {
    const service = this.#getService();
    if (service) return service.updateSettings(patch, expectedRevision);
    const descriptor = describeSettingsEntry(this.#ctx);
    return savePanelSettings({
      ctx: this.#ctx,
      patch,
      expectedRevision: expectedRevision ?? descriptor.revision,
    });
  }

  async resetSettings(expectedRevision) {
    const service = this.#getService();
    if (service) return service.resetSettings(expectedRevision);
    const descriptor = describeSettingsEntry(this.#ctx);
    return resetPanelSettings({ ctx: this.#ctx, expectedRevision: expectedRevision ?? descriptor.revision });
  }

  async testConnection(provider) {
    const service = this.#getService();
    if (service) return service.testConnection(provider);
    if (!this.#config.key) return { ok: false, error: '尚未填写 key', detail: '请先填写 WechatPad key' };
    const { WechatPadClient } = await import('./pad-api.js');
    const client = new WechatPadClient({
      baseUrl: this.#config.baseUrl,
      key: this.#config.key,
      apiPrefix: this.#config.apiPrefix,
      wxid: this.#config.wxid,
      timeoutMs: 15_000,
    });
    const result = await client.loginStatus();
    return {
      ok: result.ok,
      error: result.error,
      detail: result.ok ? 'WechatPad 可访问，key 有效' : 'WechatPad 不可访问或 key 无效',
      receiveMode: this.#config.receiveMode,
      webhookUrl: '',
    };
  }

  async reconnect(provider) {
    const service = this.#getService();
    if (!service) throw new Error('插件仍在启动，请稍后重试');
    return service.reconnect(provider);
  }

  #readyService() {
    const service = this.#getService();
    if (!service) throw new Error('插件仍在启动，请稍后重试');
    return service;
  }
  beginLogin(options) { return this.#readyService().beginLogin(options); }
  pollLogin(ticket) { return this.#readyService().pollLogin(ticket); }
  cancelLogin(ticket) { return this.#readyService().cancelLogin(ticket); }
  resetAccount() { return this.#readyService().resetAccount(); }

  listSeenGroups() {
    return this.#getService()?.listSeenGroups() ?? { items: [] };
  }
  listConversations() { return this.#getService()?.listConversations() ?? { items: [] }; }
  renameConversationGroup(groupKey, name) { return this.#readyService().renameConversationGroup(groupKey, name); }

}

/** Route Cordis logger levels onto dsh's plugin-scoped logger. */
function makeLogger(ctx) {
  let stream = null;
  const file = () => {
    if (stream) return stream;
    try {
      const dir = dshHomePath('wechatpad');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = `${dir}/wechatpad.log`;
      stream = { write: (line) => appendFileSync(path, line) };
    } catch {
      stream = { write: () => {} };
    }
    return stream;
  };

  return (level, message) => {
    if (level === 'debug') return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [wechatpad] ${message}\n`;
    // A file sink matters here: under systemd the plugin's stdout reaches the
    // journal, which is not readable in this deployment, so a delivery failure
    // would otherwise leave no evidence at all.
    try {
      file().write(line);
    } catch {
      /* logging must never break the bridge */
    }
    const sinkName = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    try {
      const sink = typeof ctx.logger === 'function' ? ctx.logger(level) : ctx.logger;
      if (typeof sink === 'function') sink(`[wechatpad] ${message}`);
      else if (sink && typeof sink[sinkName] === 'function') sink[sinkName](`[wechatpad] ${message}`);
    } catch {
      /* logging must never break the bridge */
    }
  };
}
