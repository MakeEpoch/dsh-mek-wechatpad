import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WeixinConnection } from '../host/connections/weixin.js';

const until = async (fn) => {
  const end = Date.now() + 2500;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const aborted = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
  });

test('iLink: bind -> receive -> reply with context token, redact status, cancel long poll on stop', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wxp-ilink-'));
  const accountFile = join(directory, 'credentials.json');
  const sent = [];
  const received = [];
  let polls = 0;
  let updateSignal;
  const api = {
    beginLogin: async () => ({
      qrcode: 'private-qr',
      qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test',
    }),
    pollLogin: async () => ({
      status: 'confirmed',
      bot_token: 'private-token',
      ilink_bot_id: 'bot-id',
      baseurl: 'https://ilinkai.weixin.qq.com/',
    }),
    getUpdates: async ({ signal, getUpdatesBuf }) => {
      updateSignal = signal;
      if (++polls === 1)
        return {
          ret: 0,
          get_updates_buf: 'next',
          msgs: [
            {
              message_type: 1,
              from_user_id: 'peer',
              message_id: 'm1',
              context_token: 'private-context',
              item_list: [{ type: 1, text_item: { text: 'hello' } }],
            },
          ],
        };
      assert.equal(getUpdatesBuf, 'next');
      return aborted(signal);
    },
    sendText: async (request) => {
      sent.push(request);
      return { messageId: 'out-1' };
    },
    notifyStart: async () => ({}),
  };
  const connection = new WeixinConnection({ config: {}, accountFile, api });
  t.after(async () => {
    await connection.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await connection.start({ onMessage: (message) => received.push(message) });
  assert.equal(connection.status().phase, 'unconfigured');
  const login = await connection.beginLogin();
  assert.match(login.qrcodeImage, /^data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(login), /private-qr/);
  await Promise.all([
    connection.pollLogin(login.ticket),
    connection.pollLogin(login.ticket),
  ]);
  await until(() => received.length === 1 && polls >= 2);
  assert.equal(received[0].text, 'hello');
  assert.equal(connection.status().messagesReceived, 1);
  assert.equal(connection.status().lastInbound.senderId, 'peer');
  assert.equal(connection.status().lastInbound.hasText, true);
  assert.equal('text' in connection.status().lastInbound, false);
  assert.doesNotMatch(
    JSON.stringify(connection.status()),
    /private-token|private-context/,
  );
  assert.equal((await stat(accountFile)).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(await readFile(accountFile, 'utf8')).token,
    'private-token',
  );
  assert.equal(
    (await connection.send({ chatId: 'peer', text: 'reply' })).ok,
    true,
  );
  assert.equal(sent[0].contextToken, 'private-context');
  assert.equal(
    (await connection.send({ chatId: 'stranger', text: 'reply' })).ok,
    false,
  );
  await connection.test();
  assert.equal(polls, 2, 'test never starts a competing message poll');
  await connection.stop();
  assert.equal(updateSignal.aborted, true);
  await connection.start({ onMessage() {} });
  assert.equal(
    connection.status().botId,
    'bot-id',
    'saved binding survives restart',
  );
  await connection.resetAccount();
  assert.equal(connection.status().botId, '');
  assert.deepEqual(JSON.parse(await readFile(accountFile, 'utf8')), {});
});

test('iLink: cancellation aborts an in-flight QR request before any credentials are stored', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wxp-ilink-cancel-'));
  let signal;
  const connection = new WeixinConnection({
    config: {},
    accountFile: join(directory, 'credentials.json'),
    api: {
      beginLogin: async (options) => {
        signal = options.signal;
        return aborted(signal);
      },
    },
  });
  t.after(async () => {
    await connection.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await connection.start({});
  const pending = connection.beginLogin();
  const rejected = assert.rejects(pending);
  await until(() => Boolean(signal));
  await connection.stop();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(connection.status().phase, 'stopped');
});

test('iLink: scan redirect is host-validated and already-bound responses require local credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wxp-ilink-redirect-'));
  let calls = 0;
  const connection = new WeixinConnection({
    config: {},
    accountFile: join(directory, 'credentials.json'),
    api: {
      beginLogin: async () => ({
        qrcode: 'private-qr',
        qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test',
      }),
      pollLogin: async ({ baseUrl }) => {
        if (++calls === 1)
          return {
            status: 'scaned_but_redirect',
            redirect_host: 'ilinkai.weixin.qq.com',
          };
        assert.equal(baseUrl, 'https://ilinkai.weixin.qq.com/');
        return { status: 'binded_redirect' };
      },
    },
  });
  t.after(async () => {
    await connection.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await connection.start({});
  const login = await connection.beginLogin();
  assert.equal(
    (await connection.pollLogin(login.ticket)).state,
    'scaned_but_redirect',
  );
  await assert.rejects(connection.pollLogin(login.ticket), /没有可恢复的凭据/);
});

test('iLink: fresh instance restores reply token and cursor, sends scheduled text/files without inbound, and invalidates changed credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wxp-ilink-durable-'));
  const accountFile = join(directory, 'credentials.json');
  const account = {
    token: 'test-bot-token',
    botId: 'durable-bot',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
  };
  await writeFile(accountFile, JSON.stringify(account), { mode: 0o600 });
  const sent = [];
  let polls = 0;
  let connection;
  const baseApi = {
    sendText: async (request) => {
      sent.push({ kind: 'text', request });
      return { messageId: 'out' };
    },
    sendFile: async (request) => {
      sent.push({ kind: 'file', request });
      return { messageId: 'file-out' };
    },
  };
  const firstApi = {
    ...baseApi,
    getUpdates: async ({ signal }) => {
      if (++polls === 1)
        return {
          ret: 0,
          get_updates_buf: 'saved-cursor',
          msgs: [
            {
              message_type: 1,
              from_user_id: 'peer',
              message_id: 'in-1',
              context_token: 'test-reply-token',
              create_time_ms: 1000,
              seq: 5,
              item_list: [{ type: 1, text_item: { text: 'hello' } }],
            },
          ],
        };
      return aborted(signal);
    },
  };
  connection = new WeixinConnection({ config: {}, accountFile, api: firstApi });
  t.after(async () => {
    await connection.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await connection.start({ onMessage() {} });
  await until(() => polls === 2);
  await connection.stop();
  const stateFile = join(directory, 'state', 'durable-bot.json');
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  let resumedCursor;
  const nextApi = {
    ...baseApi,
    getUpdates: async ({ signal, getUpdatesBuf }) => {
      resumedCursor = getUpdatesBuf;
      return aborted(signal);
    },
  };
  connection = new WeixinConnection({ config: {}, accountFile, api: nextApi });
  await connection.start({
    onMessage: () => assert.fail('no fresh inbound expected'),
  });
  assert.equal(resumedCursor, 'saved-cursor');
  assert.equal(connection.status().hasReplyContexts, true);
  assert.equal(
    (await connection.send({ chatId: 'peer', text: 'scheduled text' })).ok,
    true,
  );
  assert.equal(
    (
      await connection.sendFile({
        chatId: 'peer',
        file: {
          fileName: 'report.txt',
          mediaType: 'text/plain',
          bytes: Buffer.from('report'),
        },
      })
    ).ok,
    true,
  );
  assert.ok(
    sent.every((row) => row.request.contextToken === 'test-reply-token'),
  );
  assert.doesNotMatch(
    JSON.stringify(connection.status()),
    /test-bot-token|test-reply-token/,
  );
  await connection.stop();
  await writeFile(
    accountFile,
    JSON.stringify({ ...account, token: 'changed-token' }),
    { mode: 0o600 },
  );
  connection = new WeixinConnection({ config: {}, accountFile, api: nextApi });
  await connection.start({});
  assert.equal(resumedCursor, '');
  assert.equal(connection.status().hasReplyContexts, false);
  assert.equal(
    (await connection.send({ chatId: 'peer', text: 'must not use old token' }))
      .ok,
    false,
  );
  assert.equal(sent.length, 2);
  await connection.resetAccount();
  await assert.rejects(readFile(stateFile), { code: 'ENOENT' });
});
