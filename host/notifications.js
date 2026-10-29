/** One-way reminders for all live sessions. Never owns an approval or an answer. */
import { permissionReason } from './permission-text.js';
export class NotificationRelay {
  #config; #send; #logger; #stops; #seen = new Map(); #requests = new WeakSet();
  #disposed = false;
  constructor({ ctx, config, send, logger = () => {} }) {
    this.#config = config;
    this.#send = send;
    this.#logger = logger;
    this.#stops = [
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return;
        const turn = event.data.turn;
        if (!session?.id || !Number.isInteger(turn) || turn < 0 || turn <= (this.#seen.get(session.id) ?? -1)) return;
        this.#seen.delete(session.id);
        this.#seen.set(session.id, turn);
        if (this.#seen.size > 2000) this.#seen.delete(this.#seen.keys().next().value);
        this.#notify('notifyTaskCompleted', session, '任务完成', `轮次：${event.data.turn}`);
      }, { global: true }),
      ctx.on('approval/request', (request, next) => {
        if (request && !request.signal?.aborted && !this.#requests.has(request)) {
          this.#requests.add(request);
          this.#notify('notifyPermissionRequest', request.agent?.session, '权限请求', async () => [
            `工具：${short(request.toolName, 120) || '未知'}`,
            await permissionReason(ctx, request, this.#logger),
            '请回到 DSH 桌面或网页处理权限请求。此通知不接受回复。',
          ].filter(Boolean).join('\n'));
        }
        return next();
      }, { global: true, prepend: true }),
      ctx.on('session/disposed', (session) => this.#seen.delete(session?.id), { global: true }),
    ];
  }
  #notify(field, session, heading, detail) {
    try {
      this.#deliver(field, session, heading, detail);
    } catch (error) {
      this.#logger('warn', `生成微信通知失败：${error?.message ?? error}`);
    }
  }
  #deliver(field, session, heading, detail) {
    const config = this.#config();
    if (this.#disposed || !config.enabled || !config[field] || !config.notificationChatId
      || !config.enabledProviders.includes(config.notificationProvider) || !session?.id) return;
    const events = session.snapshotEvents?.() ?? session.events ?? [];
    const title = events.map((entry) => entry?.event ?? entry).findLast((event) => event?.type === 'session/title')?.data?.title;
    const context = [
      `【DSH · ${heading}】`,
      title ? `会话：${short(title, 160)}` : '',
      `会话 ID：${short(session.id, 160)}`,
      session.header?.cwd ? `工作目录：${short(session.header.cwd, 300)}` : '',
    ].filter(Boolean).join('\n');
    // Schedule delivery independently so a slow/offline provider cannot hold up
    // the session event or the approval waterfall.
    void Promise.resolve().then(async () => {
      const body = typeof detail === 'function' ? await detail() : detail;
      if (this.#disposed) return;
      const current = this.#config();
      if (!current.enabled || !current[field] || !current.enabledProviders.includes(config.notificationProvider)
        || current.notificationProvider !== config.notificationProvider || current.notificationChatId !== config.notificationChatId) return;
      return this.#send(config.notificationProvider, config.notificationChatId, `${context}\n${body}`);
    }).then((result) => {
      if (result && !result.ok) throw new Error(result.error || '发送失败');
    }).catch((error) => this.#logger('warn', `微信通知发送失败：${error?.message ?? error}`));
  }
  dispose() {
    this.#disposed = true;
    for (const stop of this.#stops.splice(0)) stop?.();
    this.#seen.clear();
  }
}

function short(value, limit) {
  return String(value ?? '').trim().slice(0, limit);
}
