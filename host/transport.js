/**
 * Connection lifecycle: the WeChat push feed feeding one message handler.
 *
 * Three receive paths exist and all of them end in `onMessage`:
 *  - `websocket` — dsh's own `/ws` upgrade route proxies to WechatPad's
 *    `/ws/GetSyncMsg`, so the Pad's `key` never reaches the browser and the
 *    browser never needs a second origin's cookies;
 *  - `webhook`  — the Pad POSTs to a dsh route and this module installs the
 *    callback registration on the Pad;
 *  - `polling`  — fallback used by tests and manual `sync` calls.
 */
import { decodeMessage } from './inbound.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_CAP_MS = 60_000;

/** Exponential reconnect delay with bounded jitter. */
export function reconnectDelay(attempt) {
  const base = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_CAP_MS);
  const jitter = Math.random() * Math.min(2_000, base / 2);
  return Math.round(Math.min(base + jitter, RECONNECT_CAP_MS));
}

/**
 * Owns the outbound WebSocket to the Pad's push feed.
 *
 * The socket is created by an injected factory so the host can supply the
 * `ws` upgrade (with its own headers/cookies) and tests can supply a fake.
 */
export class PushTransport {
  #factory;
  #logger;
  #url;
  #ws = null;
  #timers = { heartbeat: null, reconnect: null };
  #attempt = 0;
  #stopped = true;
  #onFrame;
  #onState;

  /**
   * @param {object} options
   * @param {() => Promise<{ send: Function, close: Function, on: Function }>} options.open
   *   opens one socket; the returned object is an `EventEmitter`-like socket.
   * @param {(raw: string) => void} options.onFrame receives each text frame.
   * @param {string} options.url the Pad URL, for diagnostics only.
   * @param {(level: string, msg: string) => void} [options.logger]
   * @param {(state: 'open' | 'closed' | 'error', detail?: string) => void} [options.onState]
   */
  constructor({ open, onFrame, url, logger = () => {}, onState = () => {} }) {
    this.#factory = open;
    this.#onFrame = onFrame;
    this.#url = url;
    this.#logger = logger;
    this.#onState = onState;
  }

  get connected() {
    return this.#ws !== null;
  }

  /**
   * Send one text frame upstream when the socket is open.
   * WeChat Pad ignores client traffic; a Bridge expects `{"type":"pong"}` in
   * reply to its heartbeat, so this is only meaningful in bridge mode.
   * @param {string} text frame body.
   * @returns {boolean} whether the frame was handed to an open socket.
   */
  send(text) {
    const socket = this.#ws;
    if (!socket || typeof socket.send !== 'function') return false;
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Open the feed and keep it open until `stop()`. Resolves once the first socket is up. */
  async start() {
    this.#stopped = false;
    await this.#connect();
  }

  async #connect() {
    if (this.#stopped) return;
    try {
      const socket = await this.#factory();
      this.#ws = socket;
      this.#attempt = 0;
      socket.on('message', (data) => {
        const raw = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        this.#onFrame(raw);
      });
      socket.on('close', () => {
        if (this.#ws === socket) this.#ws = null;
        this.#onState('closed');
        this.#scheduleReconnect();
      });
      socket.on('error', (error) => {
        this.#logger('warn', `微信推送连接出错：${error?.message ?? error}`);
      });
      this.#startHeartbeat();
      this.#onState('open');
      this.#logger('info', `已连接微信推送 ${this.#url}`);
    } catch (error) {
      this.#onState('error', error?.message ?? String(error));
      this.#logger('warn', `微信推送连接失败：${error?.message ?? error}`);
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#timers.reconnect) return;
    const delay = reconnectDelay(this.#attempt);
    this.#attempt += 1;
    this.#timers.reconnect = setTimeout(() => {
      this.#timers.reconnect = null;
      void this.#connect();
    }, delay);
    this.#timers.reconnect.unref?.();
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#timers.heartbeat = setInterval(() => {
      const socket = this.#ws;
      if (!socket) return;
      try {
        if (typeof socket.ping === 'function') socket.ping();
      } catch {
        /* a dead socket surfaces through its own close event */
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.#timers.heartbeat.unref?.();
  }

  #stopHeartbeat() {
    if (this.#timers.heartbeat) {
      clearInterval(this.#timers.heartbeat);
      this.#timers.heartbeat = null;
    }
  }

  /** Close the current socket and cancel every pending reconnect. */
  stop() {
    this.#stopped = true;
    this.#stopHeartbeat();
    if (this.#timers.reconnect) {
      clearTimeout(this.#timers.reconnect);
      this.#timers.reconnect = null;
    }
    const socket = this.#ws;
    this.#ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* closing an already-closed socket is not an error */
      }
    }
  }
}

/**
 * Deduplicates inbound pushes. WechatPad replays on reconnect, and webhook +
 * websocket may both deliver the same message; keyed by message id with a
 * time-bound window so memory cannot grow without bound.
 */
export class DedupeWindow {
  #seen = new Map();
  #limit;
  #ttlMs;

  constructor({ limit = 1000, ttlMs = 300_000 } = {}) {
    this.#limit = limit;
    this.#ttlMs = ttlMs;
  }

  /** @returns {boolean} true when this id was already accepted. */
  duplicate(key) {
    if (!key) return false;
    const now = Date.now();
    const seenAt = this.#seen.get(key);
    this.#prune(now);
    if (seenAt !== undefined && now - seenAt < this.#ttlMs) return true;
    this.#seen.set(key, now);
    if (this.#seen.size > this.#limit) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return false;
  }

  #prune(now) {
    for (const [key, at] of this.#seen) {
      if (now - at < this.#ttlMs) break;
      this.#seen.delete(key);
    }
  }
}

/**
 * Parse one WechatPad push frame into message records.
 * Status/error frames decode to `{ kind: 'status' }`.
 */
export function parseFrame(raw, options = {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if (Array.isArray(payload)) {
    return { kind: 'batch', messages: payload.map((item) => decodeMessage(item, options)).filter(Boolean) };
  }
  if (!payload || typeof payload !== 'object') return { kind: 'invalid' };
  if ('Code' in payload && 'Success' in payload) return { kind: 'status', payload };
  if ('event' in payload && 'data' in payload) return { kind: 'status', payload };
  const message = decodeMessage(payload, options);
  if (message) return { kind: 'message', message };
  if (payload.type === 'ping') return { kind: 'ping' };
  return { kind: 'unknown' };
}
