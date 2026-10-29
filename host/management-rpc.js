/**
 * Management RPC for the Settings panel.
 *
 * The panel is a browser plugin: it cannot read the Host's Config object, open
 * a WebSocket, or touch the filesystem. It reaches this module over dsh's
 * shared `/api` Fetch carrier (`ctx.connection.fetch.register`), which already
 * carries browser authentication, the Host/Origin fence, and the client's
 * request/response correlation. That is the same seam the shipped plugins use,
 * so the panel gets validated responses instead of a bespoke transport.
 *
 * Every method here is deliberately narrow — an allowlist of what the
 * "设置 → 微信" page may ask for.
 */
import { currentWebhookUrl } from './wechatpad-service.js';

/**
 * Channel endpoint as the browser names it. Connection composes the URL as
 * `${channel}/${endpoint}`, so the endpoint has no leading slash; the physical
 * route is `/api/dsh-wechatpad`.
 */
export const RPC_ENDPOINT = 'dsh-wechatpad';

/** Physical path the browser posts to. */
export const RPC_PATH = `/api/${RPC_ENDPOINT}`;

/** Build the envelope Connection's client expects for one result. */
function reply(rpcId, result) {
  const value = result?.ok === false
    ? { ...result, error: { ...result.error, details: result.error?.details ?? {} } }
    : result;
  return Response.json({ type: 'server-response', rpcId, result: value });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Register the panel's RPC channel.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {object} options.service panel operations (may be a facade).
 * @param {(level: string, msg: string) => void} [options.logger]
 * @returns {() => void} disposer.
 */
export async function registerManagementRpc({ ctx, service, logger = () => {} }) {
  const registry = ctx?.connection?.fetch;
  if (typeof registry?.register !== 'function') {
    throw new TypeError('dsh Connection Fetch registry is required for the settings page');
  }

  return registry.register({
    path: RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // dsh applies browser authentication and the Host/Origin trust fence
    // before this handler runs, so a request that reaches it is already trusted.
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 });

      let message;
      try {
        message = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
      const call = message?.payload;
      if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== RPC_ENDPOINT || !isRecord(call) || typeof call.method !== 'string'
        || !Object.hasOwn(call, 'payload')) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: '无效的面板请求' } });
      }

      const method = call.method;
      const payload = call.payload ?? {};
      try {
        const value = await dispatch(service, method, payload);
        return reply(rpcId, { ok: true, value });
      } catch (error) {
        logger('debug', `面板调用 ${method} 失败：${error?.message ?? error}`);
        return reply(rpcId, {
          ok: false,
          error: {
            code: typeof error?.code === 'string' ? error.code : 'wechatpad/internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
        });
      }
    },
  });
}

async function dispatch(service, method, payload) {
  switch (method) {
    case 'status.get':
      return service.status();
    case 'settings.get':
      return service.panelSettings();
    case 'settings.update':
      return service.updateSettings(payload?.patch, payload?.expectedRevision);
    case 'settings.reset':
      return service.resetSettings(payload?.expectedRevision);
    case 'connection.test':
      return service.testConnection(payload?.provider);
    case 'connection.reconnect':
      return service.reconnect(payload?.provider);
    case 'weixin.login.begin':
      return service.beginLogin(payload);
    case 'weixin.login.poll':
      return service.pollLogin(payload?.ticket ?? payload?.attemptId);
    case 'weixin.login.cancel':
      return service.cancelLogin(payload?.ticket ?? payload?.attemptId);
    case 'weixin.account.reset':
      return service.resetAccount();
    case 'groups.seen':
      return (await service.listSeenGroups?.()) ?? { items: [] };
    case 'conversations.renameGroup':
      return service.renameConversationGroup(payload?.groupKey, payload?.name);
    case 'conversations.list':
      return (await service.listConversations?.()) ?? { items: [] };
    case 'webhook.url':
      return { url: currentWebhookUrl(service) };
    default: {
      const error = new Error(`未知的接口：${method}`);
      error.code = 'wechatpad/unknown-method';
      throw error;
    }
  }
}
