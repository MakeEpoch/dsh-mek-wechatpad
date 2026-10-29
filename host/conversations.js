/** Durable conversation ownership, group names and current chat routes. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

const catalogs = new WeakMap();
const PLACEHOLDER =
  /^(?:\[(?:图片|表情|视频|语音消息|语音|链接\/文件|文件\/链接)\]\s*)+$/u;
export function cleanTitle(text, max = 26) {
  const cleaned = String(text ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f\u200b\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = [
    ...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(cleaned),
  ].map((x) => x.segment);
  return parts.length <= max
    ? cleaned
    : `${parts
        .slice(0, max - 1)
        .join('')
        .trim()}…`;
}
export function conversationSubject(message, prepared = {}) {
  const text = String(message.text ?? '').trim();
  if (text && !PLACEHOLDER.test(text))
    return { title: cleanTitle(text), generic: false };
  const transcript = /(?:^|\n)语音转写：([^\n]+)/u.exec(
    prepared.text ?? '',
  )?.[1];
  if (transcript) return { title: cleanTitle(transcript), generic: false };
  const attachment = message.attachments?.[0];
  if (attachment?.kind === 'image' || text.includes('[图片]'))
    return { title: '图片解读', generic: true };
  if (attachment?.kind === 'audio' || text.includes('[语音'))
    return { title: '语音对话', generic: true };
  if (attachment)
    return {
      title: cleanTitle(`文件 · ${attachment.name || '附件'}`),
      generic: true,
    };
  return { title: '微信对话', generic: true };
}
export function conversationLabel(provider, chatId, name) {
  const peer =
    name ||
    (chatId.endsWith('@im.wechat') ? `扫码用户 ${chatId.slice(0, 6)}` : chatId);
  return `${provider === 'weixin' ? '微信机器人' : '微信'} · ${cleanTitle(peer, 40)}`;
}
const eventsOf = (session) =>
  session.snapshotEvents?.() ?? session.events ?? [];

export class ConversationCatalog {
  #ctx;
  #logger;
  #items = new Map();
  #groupNames = new Map();
  #currentSessions = new Map();
  #pending = new Map();
  #writes = Promise.resolve();
  #path;
  ready;
  constructor(
    ctx,
    { directory = dshHomePath('wechatpad'), logger = () => {} } = {},
  ) {
    this.#ctx = ctx;
    this.#logger = logger;
    this.#path = join(directory, 'conversations.json');
    this.ready = this.#load(directory);
    void this.ready.catch((error) => this.#logger('error', error.message));
    ctx.on?.(
      'session/event',
      (session, event) => {
        if (event.type !== 'user/message') return;
        const requestId = event.data?.source?.rpcId;
        const subject = this.#pending.get(requestId);
        if (!subject || subject.sessionId !== session.id) return;
        this.#pending.delete(requestId);
        queueMicrotask(() => this.#title(session, event, subject));
      },
      { global: true },
    );
  }
  async #load(directory) {
    let migrate = true;
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      migrate = parsed.version !== 2;
      for (const [key, name] of parsed.groupNames ?? [])
        if (
          typeof key === 'string' &&
          typeof name === 'string' &&
          cleanTitle(name, 40)
        )
          this.#groupNames.set(key, cleanTitle(name, 40));
      for (const row of parsed.items ?? [])
        if (
          row?.sessionId &&
          ['pad', 'weixin'].includes(row.provider) &&
          typeof row.chatId === 'string'
        )
          this.#items.set(row.sessionId, row);
      if (!migrate) {
        if (!Array.isArray(parsed.currentSessions))
          throw new Error('当前会话索引格式无效');
        for (const [key, sessionId] of parsed.currentSessions) {
          if (
            typeof key !== 'string' ||
            (sessionId !== null &&
              (typeof sessionId !== 'string' ||
                this.#items.get(sessionId)?.groupKey !== key))
          )
            throw new Error('当前会话归属无效');
          this.#currentSessions.set(key, sessionId);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(
          `读取微信会话索引失败，请检查 conversations.json：${error.message}`,
          { cause: error },
        );
    }
    // Upgrade the plugin-owned v1 catalog once. A v2 null route is an explicit
    // /new boundary and must never fall back to older ownership history.
    if (migrate)
      for (const row of this.#items.values())
        this.#currentSessions.set(row.groupKey, row.sessionId);
    // Recover only Sessions explicitly created by this plugin in its own log.
    try {
      const log = (
        await readFile(join(directory, 'wechatpad.log'), 'utf8')
      ).slice(-8 * 1024 * 1024);
      for (const match of log.matchAll(
        /微信 (\S+) 新建会话 (session-[a-zA-Z0-9-]+)/g,
      )) {
        const [, chatId, sessionId] = match;
        const provider = chatId.endsWith('@im.wechat') ? 'weixin' : 'pad';
        if (migrate)
          this.#currentSessions.set(
            JSON.stringify([provider, chatId]),
            sessionId,
          );
        if (!this.#items.has(sessionId))
          this.#items.set(
            sessionId,
            this.#row(sessionId, {
              provider: chatId.endsWith('@im.wechat') ? 'weixin' : 'pad',
              chatId,
            }),
          );
      }
    } catch (error) {
      if (error.code !== 'ENOENT')
        this.#logger('warn', `恢复微信会话分组失败：${error.message}`);
    }
    if (migrate && this.#currentSessions.size) await this.#save(true);
  }
  owner(sessionId) {
    const row = this.#items.get(sessionId);
    return row ? {...row, current: this.#currentSessions.get(row.groupKey) === sessionId} : null;
  }
  async current(provider, chatId) {
    await this.ready;
    return (
      this.#currentSessions.get(JSON.stringify([provider, chatId])) ?? null
    );
  }
  async reset(provider, chatId, { isCurrent = () => true } = {}) {
    await this.ready;
    if (!isCurrent()) return null;
    const key = JSON.stringify([provider, chatId]);
    const had = this.#currentSessions.has(key);
    const previous = this.#currentSessions.get(key);
    this.#currentSessions.set(key, null);
    try {
      await this.#save(true);
    } catch (error) {
      if (this.#currentSessions.get(key) === null) {
        if (had) this.#currentSessions.set(key, previous);
        else this.#currentSessions.delete(key);
      }
      throw error;
    }
    return previous ?? null;
  }
  #row(sessionId, { provider, chatId, senderName }) {
    return {
      sessionId,
      provider,
      chatId,
      groupKey: JSON.stringify([provider, chatId]),
      label: conversationLabel(provider, chatId, senderName),
    };
  }
  async register(sessionId, details, { isCurrent = () => true } = {}) {
    await this.ready;
    if (!isCurrent()) return;
    const row = this.#items.get(sessionId) ?? this.#row(sessionId, details);
    if (row.groupKey !== JSON.stringify([details.provider, details.chatId]))
      throw new Error('微信会话归属不匹配');
    this.#items.set(sessionId, row);
    const had = this.#currentSessions.has(row.groupKey);
    const previous = this.#currentSessions.get(row.groupKey);
    this.#currentSessions.set(row.groupKey, sessionId);
    try {
      await this.#save(true);
    } catch (error) {
      if (this.#currentSessions.get(row.groupKey) === sessionId) {
        if (had) this.#currentSessions.set(row.groupKey, previous);
        else this.#currentSessions.delete(row.groupKey);
      }
      throw error;
    }
  }
  async list() {
    await this.ready;
    return {
      items: [...this.#items.values()].map((row) => ({
        ...row,
        label: this.#groupNames.get(row.groupKey) ?? row.label,
      })),
    };
  }
  async renameGroup(groupKey, name) {
    await this.ready;
    if (
      typeof groupKey !== 'string' ||
      ![...this.#items.values()].some((row) => row.groupKey === groupKey)
    )
      throw new Error('找不到这个微信分组，请刷新后重试');
    if (typeof name !== 'string') throw new Error('请输入分组名称');
    const label = cleanTitle(name, Number.MAX_SAFE_INTEGER);
    const length = [
      ...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(label),
    ].length;
    if (!length || length > 40) throw new Error('分组名称需为 1–40 个字符');
    const previous = this.#groupNames.get(groupKey);
    this.#groupNames.set(groupKey, label);
    try {
      await this.#save(true);
    } catch (error) {
      if (this.#groupNames.get(groupKey) === label) {
        if (previous === undefined) this.#groupNames.delete(groupKey);
        else this.#groupNames.set(groupKey, previous);
      }
      throw new Error('分组名称保存失败，请重试', { cause: error });
    }
    return this.list();
  }
  flush() {
    return this.#writes;
  }
  track(sessionId, requestId, message, prepared) {
    this.#pending.set(requestId, {
      sessionId,
      ...conversationSubject(message, prepared),
    });
  }
  forget(requestId) {
    this.#pending.delete(requestId);
  }
  #title(session, event, subject) {
    try {
      if (
        typeof session.append !== 'function' ||
        !Number.isSafeInteger(event.seq)
      )
        return;
      const row = this.#items.get(session.id);
      if (!row) return;
      const current = eventsOf(session).findLast(
        (e) => e.type === 'session/title',
      )?.data;
      if (current?.source?.kind === 'user') return; // Explicit user rename always wins.
      if (row.subject && !row.generic) return;
      if (current?.source?.kind === 'provider') return;
      session.append('session/title', {
        title: subject.title,
        messageSeqs: [event.seq],
        source: { kind: 'fallback' },
      });
      Object.assign(row, { subject: subject.title, generic: subject.generic });
      void this.#save();
    } catch (error) {
      this.#logger('warn', `设置微信会话标题失败：${error.message}`);
    }
  }
  #save(strict = false) {
    const save = async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.${randomUUID()}.tmp`;
      await writeFile(
        temp,
        JSON.stringify({
          version: 2,
          currentSessions: [...this.#currentSessions],
          items: [...this.#items.values()],
          groupNames: [...this.#groupNames],
        }),
        { mode: 0o600 },
      );
      await rename(temp, this.#path);
    };
    const result = this.#writes.then(save, save);
    this.#writes = result.catch((error) => {
      this.#logger('warn', `保存微信会话分组失败：${error.message}`);
    });
    return strict ? result : this.#writes;
  }
}
export function conversationCatalogFor(ctx, options) {
  let catalog = catalogs.get(ctx);
  if (!catalog) {
    catalog = new ConversationCatalog(ctx, options);
    catalogs.set(ctx, catalog);
  }
  return catalog;
}
