import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import { WechatPadClient } from '../host/pad-api.js';
import { createWeixinApi } from '../host/weixin-api.js';
import { WeixinConnection } from '../host/connections/weixin.js';
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  readdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { stageMedia, safeName, fetchMedia } from '../host/media.js';
import {
  weixinAttachments,
  weixinMediaKey,
  mediaUrl,
} from '../host/weixin-media.js';
import { padAttachments, isPendingPadFile } from '../host/pad-media.js';
import { normalizeAudio, encodeVoice } from '../host/voice.js';
import { decodeMessage } from '../host/inbound.js';
import { MessageInbox } from '../host/message-inbox.js';
import { WechatPadService } from '../host/wechatpad-service.js';
import { installOutboundArtifactTool } from '../host/vendor/artifact.js';
import { HarnessBridge } from '../host/harness.js';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jshkAAAAASUVORK5CYII=',
  'base64',
);
const until = async (fn) => {
  const end = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
async function dir(t) {
  const p = await mkdtemp(join(tmpdir(), 'wxp-media-'));
  t.after(() => rm(p, { recursive: true, force: true }));
  return p;
}

test('iLink encrypted images/files use trusted CDN, accept both key encodings and expose no credentials in staged prompt', async (t) => {
  const workspace = await dir(t);
  const key = Buffer.alloc(16, 9);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(PNG), cipher.final()]);
  const item = {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: 'private-query',
        aes_key: Buffer.from(key.toString('hex')).toString('base64'),
      },
    },
  };
  let calls = 0;
  const sources = weixinAttachments(
    { item_list: [item] },
    {
      fetchImpl: async (url) => {
        calls++;
        assert.equal(new URL(url).hostname, 'novac2c.cdn.weixin.qq.com');
        return new Response(encrypted);
      },
    },
  );
  assert.equal(
    calls,
    0,
    'media descriptors stay lazy until policy admits the message',
  );
  assert.deepEqual(
    weixinMediaKey({ media: { aes_key: key.toString('base64') } }),
    key,
  );
  const result = await stageMedia(
    { chatId: 'peer', text: 'what is this', attachments: sources },
    { workspace, provider: 'weixin' },
  );
  assert.equal(calls, 1);
  assert.equal(result.images.length, 1);
  assert.deepEqual(Buffer.from(result.images[0].data, 'base64'), PNG);
  assert.deepEqual(await readFile(result.files[0].path), PNG);
  assert.equal((await stat(result.files[0].path)).mode & 0o777, 0o600);
  assert.doesNotMatch(result.text, /private-query|aes_key/);
  assert.throws(() => mediaUrl({ full_url: 'https://evil.example/a' }));
  await assert.rejects(
    fetchMedia('http://127.0.0.1/x', {
      allowedHosts: ['weixin.qq.com'],
      fetchImpl: () => {
        throw new Error('must not fetch');
      },
    }),
    /不受信任/,
  );
});

test('Pad chunked image download, native voice, and CDN file use the original API shapes', async () => {
  const calls = [];
  const client = {
    async request(method, path, payload) {
      calls.push({ method, path, payload });
      if (path.endsWith('GetMsgBigImg')) {
        const offset = payload.Section?.StartPos ?? 0;
        return {
          ok: true,
          data: {
            TotalLen: PNG.length,
            Data: {
              Buffer: PNG.subarray(offset, offset ? PNG.length : 20).toString(
                'base64',
              ),
            },
          },
        };
      }
      if (path.endsWith('GetMsgVoice'))
        return {
          ok: true,
          data: { Base64: Buffer.from('voice').toString('base64') },
        };
      return {
        ok: true,
        data: { FileData: Buffer.from('document').toString('base64') },
      };
    },
  };
  const source = padAttachments(
    {
      msg_type: 3,
      msg_id: 123,
      from_user_name: { str: 'peer' },
      to_user_name: { str: 'bot' },
    },
    client,
  )[0];
  assert.deepEqual(await source.load({}), PNG);
  assert.equal(calls[1].payload.Section.StartPos, 20);
  assert.equal(calls[0].payload.MsgId, 123);
  const voice = padAttachments(
    {
      msg_type: 34,
      new_msg_id: '1799999999999999999',
      content: { str: '<msg><voicemsg length="9"/></msg>' },
    },
    client,
  )[0];
  assert.equal((await voice.load({})).toString(), 'voice');
  assert.equal(calls.at(-1).payload.NewMsgId, '1799999999999999999');
  const file = padAttachments(
    {
      msg_type: 49,
      content: {
        str: '<appmsg><title><![CDATA[report.txt]]></title><type>6</type><appattach><cdnattachurl>private-url</cdnattachurl><aeskey>private-key</aeskey></appattach></appmsg>',
      },
    },
    client,
  )[0];
  assert.equal(file.name, 'report.txt');
  assert.equal((await file.load({})).toString(), 'document');
  assert.equal(calls.at(-1).path, '/message/SendCdnDownload');
  assert.equal(
    padAttachments(
      {
        msg_type: 49,
        content: {
          str: '<appmsg><type>5</type><title>web link</title></appmsg>',
        },
      },
      client,
    ).length,
    0,
  );
  const decoded = decodeMessage({
    msg_type: 3,
    from_user_name: { str: 'peer' },
    msg_id: 4,
  });
  assert.ok(decoded.mediaPayload);
  assert.doesNotMatch(JSON.stringify(decoded), /mediaPayload/);
});

test('audio: SILK encode/decode produces WAV and uses the configured dsh recognizer', async (t) => {
  const workspace = await dir(t);
  const pcm = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++)
    pcm.writeInt16LE(
      Math.round(Math.sin((i / 24000) * 440 * Math.PI * 2) * 1000),
      i * 2,
    );
  const { encode } = await import('silk-wasm');
  const encoded = await encode(pcm, 24000);
  const audio = await normalizeAudio(Buffer.from(encoded.data));
  assert.equal(audio.bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(
    audio.bytes.readUInt32LE(24),
    16000,
    'dsh SenseVoice requires 16 kHz',
  );
  const native = await encodeVoice(Buffer.from(encoded.data));
  assert.equal(native.seconds, 1);
  let transcribed = 0;
  const speech = {
    resolve: ({ audio }) => {
      assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
      return { audio };
    },
    transcribe: async () => {
      transcribed++;
      return { text: 'voice request' };
    },
  };
  const result = await stageMedia(
    {
      chatId: 'peer',
      text: '',
      attachments: [
        { kind: 'audio', name: 'voice.silk', data: Buffer.from(encoded.data) },
      ],
    },
    { workspace, provider: 'weixin', ctx: { get: () => speech } },
  );
  assert.equal(transcribed, 1);
  assert.match(result.text, /voice request/);
  assert.equal(result.files[0].mediaType, 'audio/wav');
});

test('message merging preserves every image/file and stages safe names', async (t) => {
  const workspace = await dir(t);
  let merged;
  const inbox = new MessageInbox({
    dispatch: async (message) => {
      merged = message;
    },
    onError: () => {},
  });
  t.after(() => inbox.dispose());
  await inbox.add(
    {
      chatId: 'peer',
      senderId: 'peer',
      text: 'one',
      attachments: [{ kind: 'image', name: '../../x.png', data: PNG }],
    },
    100,
  );
  await inbox.add(
    {
      chatId: 'peer',
      senderId: 'peer',
      text: 'two',
      attachments: [
        { kind: 'file', name: '../report.txt', data: Buffer.from('data') },
      ],
    },
    0,
  );
  await until(() => Boolean(merged));
  assert.equal(merged.attachments.length, 2);
  const result = await stageMedia(merged, { workspace, provider: 'pad' });
  assert.equal(result.files.length, 2);
  assert.ok(result.files.every((f) => f.path.startsWith(workspace)));
  assert.equal(safeName('../../foo.txt'), 'foo.txt');
});

test('dsh file-return tool snapshots and sends a file only through its own chat after successful tool result', async (t) => {
  const workspace = await dir(t);
  const events = new Context();
  const sent = [];
  const prompts = [];
  let handler;
  let definition;
  let guidance;
  const session = {
    id: 'media-session',
    header: { id: 'media-session', cwd: workspace },
    events: [],
  };
  const ctx = {
    on: events.on.bind(events),
    get: (name) => (name === 'sessions' ? { get: () => session } : undefined),
    tools: {
      register: (tool) => {
        definition = tool;
      },
    },
    systemPrompt: {
      context: (source) => {
        guidance = source;
      },
    },
    connection: { createPeer: () => ({ dispose: async () => {} }) },
    typertGateway: {
      async invoke({ method, args }) {
        if (method === 'create') return { sessionId: session.id };
        if (method === 'list')
          return { items: [{ sessionId: session.id, cwd: workspace }] };
        if (method !== 'prompt') return {};
        prompts.push(args.request);
        const turn = prompts.length - 1;
        const start = { type: 'turn/start', data: { turn } };
        session.events.push(start);
        await events.emit('session/event', session, start);
        await events.emit('session/event', session, {
          type: 'user/message',
          data: { source: { kind: 'user', rpcId: args.request.requestId } },
        });
        assert.match(
          guidance.text({ agent: { session } }),
          /wechatpad_return_file/,
        );
        const path = join(workspace, 'result.txt');
        await writeFile(path, 'original report');
        const exec = {
          name: 'wechatpad_return_file',
          agent: { session },
          callId: 'return-call',
        };
        await definition.execute({ path }, exec);
        await events.emit('tools/result', exec, { isError: false });
        await writeFile(path, 'changed after registration');
        await events.emit('session/event', session, {
          type: 'assistant/message',
          data: {
            message: { content: [{ type: 'text', text: 'file prepared' }] },
          },
        });
        const end = { type: 'turn/end', data: { turn } };
        session.events.push(end);
        await events.emit('session/event', session, end);
        return { accepted: true };
      },
    },
  };
  installOutboundArtifactTool(ctx);
  const connection = {
    id: 'weixin',
    label: 'bot',
    capabilities: { media: true },
    start: async (next) => {
      handler = next;
      next.onState({ phase: 'connected' });
    },
    stop: async () => {},
    send: async ({ text }) => {
      sent.push({ text });
      return { ok: true, delivered: 1 };
    },
    sendFile: async ({ chatId, file }) => {
      sent.push({ chatId, file });
      return { ok: true, delivered: 1 };
    },
    test: async () => ({ ok: true }),
  };
  const service = new WechatPadService({
    ctx,
    config: { provider: 'weixin', cwd: workspace, showProgress: false },
    createConnection: async () => connection,
  });
  t.after(() => service.dispose());
  await service.start();
  await handler.onMessage({
    messageId: 'file-only',
    chatId: 'peer',
    senderId: 'peer',
    text: '',
    msgType: 1,
    isGroup: false,
    attachments: [
      { kind: 'file', name: 'request.txt', data: Buffer.from('user document') },
    ],
  });
  await until(() => sent.some((item) => item.file));
  assert.match(prompts[0].content[0].text, /request.txt/);
  const outbound = sent.find((item) => item.file);
  assert.equal(outbound.chatId, 'peer');
  assert.equal(outbound.file.bytes.toString(), 'original report');
  assert.equal(outbound.file.fileName, 'result.txt');
  const webExec = {
    name: 'wechatpad_return_file',
    agent: {
      session: {
        id: 'web',
        header: { id: 'web', cwd: workspace },
        events: [{ type: 'turn/start', data: { turn: 0 } }],
      },
    },
    callId: 'web-call',
  };
  await assert.rejects(
    definition.execute({ path: join(workspace, 'result.txt') }, webExec),
    /No active IM delivery consumer/,
  );
});

test('image fallback retries only explicit pre-admission image rejection and keeps request identity', async () => {
  const calls = [];
  const bridge = new HarnessBridge({
    peer: {},
    gateway: {
      invoke: async (request) => {
        calls.push(request);
        if (calls.length === 1) {
          const e = new Error('non-vision');
          e.code = 'session/attachment-invalid';
          e.details = { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' };
          throw e;
        }
        return { accepted: true };
      },
    },
  });
  await bridge.prompt({
    sessionId: 's',
    requestId: 'same-id',
    text: 'original at /workspace/image.png',
    images: [{ mediaType: 'image/png', data: PNG.toString('base64') }],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.request.requestId, 'same-id');
  assert.equal(calls[1].args.request.content.length, 1);
  assert.match(calls[1].args.request.content[0].text, /原图已保存/);
});

test('Pad and Bridge send real HTTP image/voice/file shapes, route credentials and do not retry uncertain uploads', async (t) => {
  const calls = [];
  let mode = 'normal';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({
      url: new URL(request.url, 'http://localhost'),
      body: JSON.parse(Buffer.concat(chunks)),
    });
    const call = calls.at(-1);
    const upload = call.url.pathname.endsWith('/other/UploadAppAttach');
    const app = call.url.pathname.endsWith('/message/SendAppMessage');
    const voice = call.url.pathname.endsWith('/message/SendVoice');
    assert.ok(!call.url.pathname.endsWith('/SendFileMessage'), 'removed legacy endpoint must never be called');
    if ((upload && mode === 'upload-fail') || (app && mode === 'send-fail')) {
      response.writeHead(503).end('temporary network failure');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        Success: !voice,
        Code: 200,
        Data: upload ? (mode === 'missing-id' ? {} : { mediaId: { str: 'attachment<&id' }, totalLen: 6 })
          : voice ? { base_response: { ret: -104, errMsg: { str: '' } } }
          : app ? [{ MsgId: 'receipt', retCode: mode === 'send-reject' ? -2 : 0 }]
            : { MsgId: 'receipt' },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const bridge of [false, true]) {
    mode = 'normal';
    const client = new WechatPadClient({
      baseUrl,
      key: 'private-pad-key',
      ...(bridge ? { apiPrefix: '/proxy', wxid: 'bot' } : {}),
    });
    assert.equal(
      (await client.sendImage('peer', PNG.toString('base64'))).ok,
      true,
    );
    assert.equal(
      (
        await client.sendVoice('peer', {
          bytes: Buffer.from('silk'),
          seconds: 2,
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await client.sendFile('peer', {
          fileName: '报告.txt',
          bytes: Buffer.from('report'),
        })
      ).ok,
      true,
    );
    const [image, voice, upload, file] = calls.slice(-4);
    assert.equal(
      image.url.pathname,
      `${bridge ? '/proxy/bot' : ''}/message/SendImageNewMessage`,
    );
    assert.equal(
      image.url.searchParams.get('key'),
      bridge ? null : 'private-pad-key',
    );
    assert.deepEqual(
      Buffer.from(image.body.MsgItem[0].ImageContent, 'base64'),
      PNG,
    );
    assert.equal(voice.body.VoiceFormat, 4);
    assert.equal(voice.body.VoiceSecond, 2);
    assert.equal(upload.url.pathname, `${bridge ? '/proxy/bot' : ''}/other/UploadAppAttach`);
    assert.equal(file.url.pathname, `${bridge ? '/proxy/bot' : ''}/message/SendAppMessage`);
    assert.ok([image, voice, upload, file].every(x => x.url.searchParams.get('key') === (bridge ? null : 'private-pad-key')));
    assert.equal(
      Buffer.from(upload.body.fileData, 'base64').toString(),
      'report',
    );
    assert.equal(file.body.AppList[0].ContentType, 6);
    assert.equal(file.body.AppList[0].ToUserName, 'peer');
    assert.match(file.body.AppList[0].ContentXML, /<title>报告.txt<\/title>/);
    assert.match(file.body.AppList[0].ContentXML, /<attachid>attachment&lt;&amp;id<\/attachid>/);
    assert.match(file.body.AppList[0].ContentXML, /<totallen>6<\/totallen>/);
    for (const [failure, count, error] of [['upload-fail', 1, /文件上传失败/], ['missing-id', 1, /未返回 mediaId/], ['send-reject', 2, /retCode=-2/], ['send-fail', 2, /HTTP 503/]]) {
      mode = failure;
      const before = calls.length;
      const result = await client.sendFile('peer', { fileName: 'fail.txt', bytes: Buffer.from('failed') });
      assert.equal(result.ok, false);
      assert.match(result.error, error);
      assert.equal(calls.length, before + count, 'failed upload/send is never retried or sent via a legacy route');
    }
    mode = 'normal';
    assert.equal((await client.sendFile('peer', { fileName: '报告 & <v2>.txt', bytes: Buffer.from('report') })).ok, true);
    assert.match(calls.at(-1).body.AppList[0].ContentXML, /<title>报告 &amp; &lt;v2&gt;.txt<\/title>/);
  }
});

test('iLink sends images and audio/files through encrypted CDN upload followed by same-chat sendmessage', async () => {
  const wire = [];
  let uploadKey;
  let uploaded;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/c2c/upload') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      const decipher = createDecipheriv('aes-128-ecb', uploadKey, null);
      uploaded = Buffer.concat([
        decipher.update(Buffer.concat(chunks)),
        decipher.final(),
      ]);
      assert.equal(
        options.headers.Authorization,
        undefined,
        'bot token never travels to CDN',
      );
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'private-download' },
      });
    }
    const body = JSON.parse(options.body);
    wire.push({ path, body });
    if (path.endsWith('getuploadurl')) {
      uploadKey = Buffer.from(body.aeskey, 'hex');
      return Response.json({ ret: 0, upload_param: 'private-upload' });
    }
    return Response.json({ ret: 0 });
  };
  const api = createWeixinApi({ fetchImpl });
  for (const [method, mediaType, bytes] of [
    ['sendImage', 1, PNG],
    ['sendFile', 3, Buffer.from('audio-or-file')],
  ]) {
    await api[method]({
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      token: 'private-token',
      toUserId: 'peer',
      contextToken: 'private-context',
      file: { fileName: 'out.wav', bytes },
    });
    assert.deepEqual(uploaded, bytes);
    const [upload, sent] = wire.slice(-2);
    assert.equal(upload.body.media_type, mediaType);
    assert.equal(sent.body.msg.to_user_id, 'peer');
    assert.equal(sent.body.msg.context_token, 'private-context');
    const item = sent.body.msg.item_list[0];
    assert.equal(item.type, method === 'sendImage' ? 2 : 4);
    assert.deepEqual(
      weixinMediaKey(method === 'sendImage' ? item.image_item : item.file_item),
      uploadKey,
    );
  }
});

test('iLink admits image-only messages and routes outgoing media using the received reply credential', async (t) => {
  const workspace = await dir(t);
  const accountFile = join(workspace, 'account.json');
  await writeFile(
    accountFile,
    JSON.stringify({
      token: 'private-token',
      botId: 'bot',
      baseUrl: 'https://ilinkai.weixin.qq.com/',
    }),
  );
  let polls = 0;
  const received = [];
  const sent = [];
  const api = {
    getUpdates: async ({ signal }) => {
      if (++polls === 1)
        return {
          msgs: [
            {
              message_type: 1,
              from_user_id: 'peer',
              message_id: 'image-message',
              context_token: 'reply-token',
              item_list: [
                {
                  type: 2,
                  image_item: {
                    media: {
                      encrypt_query_param: 'q',
                      aes_key: Buffer.alloc(16).toString('base64'),
                    },
                  },
                },
              ],
            },
          ],
        };
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
    sendImage: async (args) => {
      sent.push(['image', args]);
      return { messageId: 'out' };
    },
    sendFile: async (args) => {
      sent.push(['file', args]);
      return { messageId: 'out' };
    },
  };
  const connection = new WeixinConnection({ config: {}, api, accountFile });
  t.after(() => connection.stop());
  await connection.start({ onMessage: (message) => received.push(message) });
  await until(() => received.length === 1);
  assert.equal(received[0].attachments.length, 1);
  assert.equal(received[0].text, '');
  assert.equal(
    (
      await connection.sendFile({
        chatId: 'peer',
        file: { mediaType: 'image/png', bytes: PNG, fileName: 'out.png' },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await connection.sendFile({
        chatId: 'peer',
        file: {
          mediaType: 'audio/wav',
          bytes: Buffer.from('wav'),
          fileName: 'out.wav',
        },
      })
    ).ok,
    true,
  );
  assert.deepEqual(
    sent.map((call) => call[0]),
    ['image', 'file'],
  );
  assert.ok(sent.every((call) => call[1].contextToken === 'reply-token'));
  assert.equal(
    (await connection.sendFile({ chatId: 'other-peer', file: {} })).ok,
    false,
  );
});

test('staging keeps provider transcripts and cancels downloads without leaving partial files', async (t) => {
  const workspace = await dir(t);
  // A real tiny PCM WAV fixture: silence is enough to validate transcript handling.
  const { encode } = await import('silk-wasm');
  const audio = Buffer.from((await encode(Buffer.alloc(4800), 24000)).data);
  const result = await stageMedia(
    {
      chatId: 'peer',
      text: '[语音]',
      attachments: [
        {
          kind: 'audio',
          name: 'voice.silk',
          data: audio,
          transcript: 'provider transcription',
        },
      ],
    },
    {
      workspace,
      provider: 'pad',
      ctx: {
        get: () => {
          throw new Error('must not transcribe again');
        },
      },
    },
  );
  assert.match(result.text, /provider transcription/);
  const controller = new AbortController();
  let began;
  const pending = stageMedia(
    {
      chatId: 'peer',
      text: '',
      attachments: [
        {
          kind: 'file',
          name: 'pending.txt',
          load: ({ signal }) =>
            new Promise((_, reject) => {
              began = true;
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            }),
        },
      ],
    },
    { workspace, provider: 'pad', signal: controller.signal },
  );
  await until(() => began);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
});

test('Pad embedded data and workspace symlink guards match supported payloads', async (t) => {
  const source = padAttachments(
    {
      msg_type: 49,
      data: Buffer.from('embedded document').toString('base64'),
      content: { str: '<appmsg><title>x.txt</title><type>6</type></appmsg>' },
    },
    {
      request: () => {
        throw new Error('must use embedded bytes');
      },
    },
  )[0];
  assert.equal((await source.load()).toString(), 'embedded document');
  const workspace = await dir(t);
  const outside = await dir(t);
  await symlink(outside, join(workspace, '.dsh-wechatpad'));
  await assert.rejects(
    stageMedia(
      {
        chatId: 'peer',
        attachments: [
          { kind: 'file', name: 'x.txt', data: Buffer.from('data') },
        ],
      },
      { workspace, provider: 'pad' },
    ),
    /符号链接/,
  );
  assert.deepEqual(
    await readdir(outside),
    [],
    'nothing created outside session workspace',
  );
});


test('Pad ignores upload notifications before admission so the complete file retains its dedupe id', () => {
  const pending = { msg_type:49, new_msg_id:'shared-id', content:{str:'<msg><appmsg><title>file.txt</title><type>74</type><appattach><fileuploadtoken>pending</fileuploadtoken></appattach></appmsg></msg>'} };
  const ready = { ...pending, content:{str:'<msg><appmsg><title>file.txt</title><type>6</type><appattach><attachid>download</attachid><aeskey>key</aeskey></appattach></appmsg></msg>'} };
  assert.equal(isPendingPadFile(pending),true);
  assert.equal(padAttachments(pending,{}).length,0);
  assert.equal(isPendingPadFile(ready),false);
  assert.equal(padAttachments(ready,{}).length,1);
});
