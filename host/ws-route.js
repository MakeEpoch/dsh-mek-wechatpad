/**
 * dsh Web route registrations.
 *
 * Everything WeChat-related is served from the dsh origin, so the host adds no
 * second listener and no second credential:
 *  - `GET /dsh-wechatpad/ws` upgrades the connection into the Pad's push feed
 *    (`/ws/GetSyncMsg`) and forwards text frames verbatim;
 *  - `POST /dsh-wechatpad/callback` receives the Pad's webhook pushes.
 *
 * These are raw `ctx.webServer` routes, registered only after the plugin has
 * verified the caller through `ctx.connection.requestRejection` — the same
 * Host/Origin fence and browser/API authentication every dsh route goes
 * through — so the `key` never has to travel to a browser.
 */
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';

const require = createRequire(import.meta.url);

export const WS_PATH = '/dsh-wechatpad/ws';
export const WEBHOOK_PATH = '/dsh-wechatpad/callback';

/** Constant-time token comparison for the webhook route. */
function secretEquals(expected, actual) {
  if (!expected || !actual) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(actual));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Whether the caller may open the push socket.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('node:http').IncomingMessage} request
 * @returns {{ allowed: boolean, status?: number }}
 */
export function admit(ctx, request) {
  try {
    const rejection = ctx.connection.requestRejection(request);
    if (rejection !== undefined && rejection !== null) {
      return { allowed: false, status: typeof rejection === 'number' ? rejection : (rejection.status ?? 403) };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, status: 403 };
  }
}

/**
 * Register the WebSocket upgrade route proxying WechatPad's push feed.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {() => { url: string, key: string } | null} options.padTarget
 * @param {(frame: string) => void} options.onFrame
 * @param {(level: string, msg: string) => void} [options.logger]
 * @returns {() => void} disposer.
 */
export function registerPushRoute({ ctx, padTarget, onFrame, logger = () => {} }) {
  const { WebSocketServer, WebSocket } = require('ws');
  const server = new WebSocketServer({ noServer: true });

  return ctx.webServer.registerUpgrade({
    path: WS_PATH,
    handler: (request, socket, head) => {
      const gate = admit(ctx, request);
      const target = padTarget();
      if (!gate.allowed || !target) {
        socket.destroy();
        return;
      }
      server.handleUpgrade(request, socket, head, (client) => {
        pump({ client, target, onFrame, logger, WebSocket });
      });
    },
  });
}

function pump({ client, target, onFrame, logger, WebSocket }) {
  const upstream = new WebSocket(target.url, { handshakeTimeout: 15_000 });
  let closed = false;
  const heartbeat = setInterval(() => {
    try {
      if (upstream.readyState === WebSocket.OPEN) upstream.ping();
    } catch {
      /* surfaced by the error handler */
    }
  }, 30_000);
  heartbeat.unref?.();

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const socket of [upstream, client]) {
      try {
        if (socket.readyState <= WebSocket.OPEN) socket.close();
        else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      } catch {
        /* already gone */
      }
    }
  };

  upstream.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    // Fold the frame here as well: the browser may never connect, and the
    // Pad's push feed is the authoritative inbound source either way.
    onFrame(text);
    if (client.readyState === WebSocket.OPEN) client.send(text);
  });
  upstream.on('open', () => logger('debug', `已连接 WechatPad 推送 ${target.url}`));
  upstream.on('close', closeBoth);
  upstream.on('error', (error) => {
    logger('warn', `WechatPad 推送连接失败：${error?.message ?? error}`);
    closeBoth();
  });
  client.on('close', closeBoth);
  client.on('error', closeBoth);
}

/**
 * Register the webhook receiver.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {string} options.path absolute pathname to claim.
 * @param {() => { token: string } } options.webhookAuth current expected token.
 * @param {(payload: unknown) => void} options.onPayload
 * @param {(level: string, msg: string) => void} [options.logger]
 * @returns {() => void} disposer.
 */
export function registerWebhookRoute({ ctx, path, webhookAuth, onPayload, logger = () => {} }) {
  /** Writes one status exactly once, even if a later branch is entered. */
  const respond = (response, status, body, headers = {}) => {
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(status, headers).end(body);
  };

  return ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        respond(response, 405, 'method not allowed', { allow: 'POST' });
        return;
      }
      const gate = admit(ctx, request);
      if (!gate.allowed) {
        respond(response, gate.status ?? 403, 'forbidden');
        return;
      }
      const expected = webhookAuth()?.token ?? '';
      const provided = request.headers['x-wechatpad-token'];
      if (!secretEquals(expected, Array.isArray(provided) ? provided[0] : provided)) {
        respond(response, 401, 'invalid webhook token');
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          respond(response, 413, 'payload too large');
          request.destroy();
          return;
        }
        chunks.push(chunk);
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        respond(response, 400, 'invalid json');
        return;
      }
      try {
        onPayload(payload);
      } catch (error) {
        logger('error', `webhook 消息处理失败：${error?.message ?? error}`);
      }
      respond(response, 200, '{"ok":true}', { 'content-type': 'application/json' });
    },
  });
}
