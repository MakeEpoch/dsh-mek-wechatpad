import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import {
  ConversationCatalog,
  conversationSubject,
  cleanTitle,
} from '../host/conversations.js';

async function fixture(t) {
  const directory = await mkdtemp('/tmp/wxp-conversations-');
  const ctx = new Context();
  const catalog = new ConversationCatalog(ctx, { directory });
  t.after(async () => {
    await catalog.flush();
    await rm(directory, { recursive: true, force: true });
  });
  await catalog.ready;
  return { directory, ctx, catalog };
}
test('conversation subjects prefer actual text/transcripts and never use attachment staging boilerplate', () => {
  assert.deepEqual(
    conversationSubject({ text: '帮我分析这个订单的退款原因' }),
    { title: '帮我分析这个订单的退款原因', generic: false },
  );
  assert.equal(
    conversationSubject(
      { text: '[语音消息]', attachments: [{ kind: 'audio' }] },
      { text: '语音转写：核对本月费用\n\n本条微信附件已保存 /home/private' },
    ).title,
    '核对本月费用',
  );
  assert.equal(
    conversationSubject({ text: '[图片]', attachments: [{ kind: 'image' }] })
      .title,
    '图片解读',
  );
  assert.equal(
    conversationSubject({
      text: '',
      attachments: [{ kind: 'file', name: '报告.xlsx' }],
    }).title,
    '文件 · 报告.xlsx',
  );
  assert.doesNotMatch(cleanTitle('题目\u202e\u0001\n内容'), /[\u202e\u0001\n]/);
  assert.ok([...cleanTitle('很长的中文标题'.repeat(20))].length <= 26);
});
test('durable grouping recovers only plugin-owned sessions and isolates the same peer on both connections', async (t) => {
  const { directory, catalog } = await fixture(t);
  await catalog.register('pad-session', { provider: 'pad', chatId: 'alice' });
  await catalog.register('qr-session', { provider: 'weixin', chatId: 'alice' });
  const rows = (await catalog.list()).items;
  assert.notEqual(rows[0].groupKey, rows[1].groupKey);
  const saved = JSON.parse(
    await readFile(`${directory}/conversations.json`, 'utf8'),
  );
  assert.equal(saved.items.length, 2);
  assert.ok(
    saved.items.every((row) => !('cwd' in row) && !('messages' in row)),
  );
  await writeFile(
    `${directory}/wechatpad.log`,
    'INFO 微信 user_example 新建会话 session-old-owned\nINFO unrelated session-other\n',
  );
  const loaded = new ConversationCatalog(new Context(), { directory });
  const restored = (await loaded.list()).items;
  assert.equal(restored.length, 3);
  assert.equal(
    restored.find((row) => row.sessionId === 'session-old-owned').chatId,
    'user_example',
  );
  assert.ok(restored.every((row) => row.sessionId !== 'session-other'));
});
test('content titles stay automatic, replace generic subjects later and preserve manual renames', async (t) => {
  const { ctx, catalog } = await fixture(t);
  await catalog.register('s', { provider: 'pad', chatId: 'peer' });
  const session = {
    id: 's',
    events: [],
    append(type, data) {
      this.events.push({ type, data, seq: this.events.length });
    },
  };
  const emit = async (id, message) => {
    catalog.track('s', id, message, {});
    const event = {
      type: 'user/message',
      seq: session.events.length,
      data: { source: { kind: 'user', rpcId: id } },
    };
    session.events.push(event);
    await ctx.emit('session/event', session, event);
    await new Promise((resolve) => setImmediate(resolve));
  };
  await emit('image', { text: '[图片]', attachments: [{ kind: 'image' }] });
  assert.equal(session.events.at(-1).data.title, '图片解读');
  assert.equal(session.events.at(-1).data.source.kind, 'fallback');
  await emit('topic', { text: '识别图片中的二维码' });
  assert.equal(session.events.at(-1).data.title, '识别图片中的二维码');
  session.append('session/title', {
    title: '我自己起的标题',
    source: { kind: 'user' },
    messageSeqs: [],
  });
  await emit('later', { text: '别的话题' });
  assert.equal(
    session.events.findLast((e) => e.type === 'session/title').data.title,
    '我自己起的标题',
  );
});

test('group names persist for existing and future sessions, without changing routing or another provider', async (t) => {
  const { directory, catalog } = await fixture(t);
  await catalog.register('pad-a', { provider: 'pad', chatId: 'alice' });
  await catalog.register('qr-a', { provider: 'weixin', chatId: 'alice' });
  const key = (await catalog.list()).items[0].groupKey;
  await catalog.renameGroup(key, '  我的微信  ');
  await catalog.register('pad-new', { provider: 'pad', chatId: 'alice' });
  const restored = new ConversationCatalog(new Context(), { directory });
  const rows = (await restored.list()).items;
  assert.deepEqual(
    rows.filter((row) => row.provider === 'pad').map((row) => row.label),
    ['我的微信', '我的微信'],
  );
  assert.equal(
    rows.find((row) => row.provider === 'weixin').label,
    '微信机器人 · alice',
  );
  assert.ok(rows.every((row) => row.chatId === 'alice' && !('cwd' in row)));
  await assert.rejects(catalog.renameGroup('unknown', '名称'), /找不到/);
  await assert.rejects(catalog.renameGroup(key, ' \n '), /1–40/);
  await assert.rejects(catalog.renameGroup(key, '名'.repeat(41)), /1–40/);
  assert.equal((await catalog.list()).items[0].label, '我的微信');
});

test('failed group-name persistence reports failure and keeps the previous label', async (t) => {
  const { directory, catalog } = await fixture(t);
  await catalog.register('pad-a', { provider: 'pad', chatId: 'alice' });
  const key = (await catalog.list()).items[0].groupKey;
  await rm(`${directory}/conversations.json`);
  await mkdir(`${directory}/conversations.json`);
  await assert.rejects(catalog.renameGroup(key, '无法保存'), /保存失败/);
  await catalog.flush();
  assert.equal((await catalog.list()).items[0].label, '微信 · alice');
});

test('v1 upgrade selects the latest owned session and persists the route without changing names', async (t) => {
  const { directory } = await fixture(t);
  const key = JSON.stringify(['pad', 'alice']);
  await writeFile(
    `${directory}/conversations.json`,
    JSON.stringify({
      version: 1,
      groupNames: [[key, '我的微信']],
      items: [
        {
          sessionId: 'session-old',
          provider: 'pad',
          chatId: 'alice',
          groupKey: key,
          label: '微信 · alice',
        },
      ],
    }),
  );
  await writeFile(
    `${directory}/wechatpad.log`,
    'INFO 微信 alice 新建会话 session-old\nINFO 微信 alice 新建会话 session-new\n',
  );
  const loaded = new ConversationCatalog(new Context(), { directory });
  assert.equal(await loaded.current('pad', 'alice'), 'session-new');
  assert.equal((await loaded.list()).items[0].label, '我的微信');
  assert.equal(
    JSON.parse(await readFile(`${directory}/conversations.json`, 'utf8'))
      .version,
    2,
  );
  await loaded.reset('pad', 'alice');
  const restored = new ConversationCatalog(new Context(), { directory });
  assert.equal(
    await restored.current('pad', 'alice'),
    null,
    'reset boundary wins over creation logs',
  );
  assert.equal(
    (await restored.list()).items.length,
    2,
    'old conversations remain in history',
  );
});
test('current routes survive a fresh catalog and stay isolated by provider and chat', async (t) => {
  const { directory, catalog } = await fixture(t);
  await catalog.register('pad-1', { provider: 'pad', chatId: 'alice' });
  await catalog.register('qr-1', { provider: 'weixin', chatId: 'alice' });
  await catalog.register('pad-other', { provider: 'pad', chatId: 'bob' });
  await catalog.reset('pad', 'alice');
  const loaded = new ConversationCatalog(new Context(), { directory });
  assert.equal(await loaded.current('pad', 'alice'), null);
  assert.equal(await loaded.current('weixin', 'alice'), 'qr-1');
  assert.equal(await loaded.current('pad', 'bob'), 'pad-other');
  await loaded.register(
    'pad-cancelled',
    { provider: 'pad', chatId: 'alice' },
    { isCurrent: () => false },
  );
  assert.equal(
    await loaded.current('pad', 'alice'),
    null,
    'cancelled admission cannot restore a reset route',
  );
  await loaded.register('pad-2', { provider: 'pad', chatId: 'alice' });
  const again = new ConversationCatalog(new Context(), { directory });
  assert.equal(await again.current('pad', 'alice'), 'pad-2');
});
test('failed route persistence never reports reset success or drops the current conversation', async (t) => {
  const { directory, catalog } = await fixture(t);
  await catalog.register('pad-1', { provider: 'pad', chatId: 'alice' });
  await rm(`${directory}/conversations.json`);
  await mkdir(`${directory}/conversations.json`);
  await assert.rejects(catalog.reset('pad', 'alice'));
  assert.equal(await catalog.current('pad', 'alice'), 'pad-1');
});
test('unreadable route state fails closed instead of pretending this is a new conversation', async (t) => {
  const { directory } = await fixture(t);
  await writeFile(`${directory}/conversations.json`, '{broken');
  const loaded = new ConversationCatalog(new Context(), { directory });
  await assert.rejects(loaded.current('pad', 'alice'), /读取微信会话索引失败/);
});
