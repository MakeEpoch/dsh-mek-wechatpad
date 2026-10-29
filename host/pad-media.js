/** Pad/Bridge media endpoints follow Hermes' WechatPad adapter. */
import {
  decodeBase64,
  fetchMedia,
  safeName,
  mediaTypeFor,
  MAX_MEDIA_BYTES,
} from './media.js';
const str = (value) => (typeof value === 'string' ? value : (value?.str ?? ''));
const entities = (text) =>
  String(text)
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
export function xmlText(xml, tag) {
  const value =
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)?.[1] ??
    '';
  return entities(value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'));
}
export function xmlAttrs(xml, tag) {
  const body = new RegExp(`<${tag}\\b([^>]*)>`, 'i').exec(xml)?.[1] ?? '';
  return Object.fromEntries(
    [...body.matchAll(/([\w:]+)\s*=\s*["']([^"']*)["']/g)].map((m) => [
      m[1].toLowerCase(),
      entities(m[2]),
    ]),
  );
}
function embedded(raw) {
  for (const item of [
    raw,
    raw.img_buf,
    raw.voice_data,
    raw.file_data,
    raw.buffer,
  ]) {
    if (!item || typeof item !== 'object') continue;
    for (const key of [
      'buffer',
      'Buffer',
      'base64',
      'Base64',
      'data',
      'Data',
      'FileContent',
      'VoiceData',
      'ImageContent',
    ]) {
      if (typeof item[key] === 'string' && item[key].length) {
        try {
          return decodeBase64(item[key]);
        } catch {
          /* try the provider download instead */
        }
      }
    }
  }
  return null;
}
function responseBytes(data) {
  if (typeof data === 'string') return decodeBase64(data);
  if (data && typeof data === 'object') {
    for (const key of [
      'Base64',
      'base64',
      'Buffer',
      'buffer',
      'FileContent',
      'FileData',
      'VoiceData',
      'ImageContent',
      'Data',
      'data',
    ]) {
      if (data[key] !== undefined) {
        try {
          return responseBytes(data[key]);
        } catch {
          /* other wire versions use another key */
        }
      }
    }
  }
  throw new Error('WechatPad 未返回附件数据');
}
async function requestBytes(client, path, payload, signal) {
  const result = await client.request('POST', path, payload, {
    retries: 0,
    signal,
  });
  if (!result.ok) throw new Error(result.error || 'WechatPad 附件下载失败');
  return responseBytes(result.data);
}
async function chunked(client, path, raw, signal) {
  const msgId = raw.msg_id ?? raw.MsgId;
  if (msgId === undefined || msgId === null)
    throw new Error('附件缺少原始 msg_id');
  const args = {
    MsgId: Number(msgId),
    FromUserName: str(raw.from_user_name) || raw.FromUserName,
    ToUserName: str(raw.to_user_name) || raw.ToUserName,
  };
  const chunks = [];
  let size = 0,
    total = 0;
  do {
    signal?.throwIfAborted();
    const result = await client.request(
      'POST',
      path,
      {
        ...args,
        ...(size
          ? {
              TotalLen: total,
              Section: {
                StartPos: size,
                DataLen: Math.min(65536, total - size),
              },
            }
          : {}),
      },
      { retries: 0, signal },
    );
    if (!result.ok) throw new Error(result.error);
    const data = result.data;
    const bytes = responseBytes(data?.Data ?? data);
    if (!size) total = Number(data?.TotalLen ?? bytes.length);
    if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_MEDIA_BYTES)
      throw new Error('附件长度无效或超过 64 MiB');
    if (!bytes.length || size + bytes.length > total)
      throw new Error('附件分块长度无效');
    chunks.push(bytes);
    size += bytes.length;
  } while (size < total);
  return Buffer.concat(chunks);
}
const CDN_HOSTS = [
  'wx.qq.com',
  'weixin.qq.com',
  'weixin.com',
  'qpic.cn',
  'qlogo.cn',
  'qq.com',
];
/** Type 74 is an upload notification; type 6 follows with the same new_msg_id. */
export function isPendingPadFile(raw) {
  if (Number(raw.msg_type ?? raw.MsgType) !== 49) return false;
  return xmlText(str(raw.content) || raw.Content || '', 'type') === '74';
}
export function padAttachments(raw, client) {
  const type = Number(raw.msg_type ?? raw.MsgType);
  const xml = str(raw.content) || raw.Content || '';
  if (![3, 34, 43, 47, 49].includes(type)) return [];
  const appType = xmlText(xml, 'type');
  if (type === 49 && appType && appType !== '6') return [];
  const kind =
    type === 3 || type === 47
      ? 'image'
      : type === 34
        ? 'audio'
        : type === 43
          ? 'video'
          : 'file';
  const name = safeName(
    type === 49
      ? xmlText(xml, 'title')
      : type === 34
        ? 'voice.silk'
        : type === 43
          ? 'video.mp4'
          : type === 47
            ? 'emoji.gif'
            : 'image.jpg',
  );
  const voice = xmlAttrs(xml, 'voicemsg');
  const transcript = voice.voicetext || xmlText(xml, 'voicetrans') || '';
  return [
    {
      kind,
      name,
      mediaType: mediaTypeFor(name),
      transcript,
      async load({ signal } = {}) {
        const direct = embedded(raw);
        if (kind === 'audio')
          return (
            direct ??
            requestBytes(
              client,
              '/message/GetMsgVoice',
              {
                NewMsgId: String(
                  raw.new_msg_id ?? raw.NewMsgId ?? raw.msg_id ?? '',
                ),
                Length: Number(voice.length ?? 0),
                ToUserName: str(raw.to_user_name) || raw.ToUserName,
              },
              signal,
            )
          );
        if (kind === 'image' && type !== 47) {
          try {
            return await chunked(client, '/message/GetMsgBigImg', raw, signal);
          } catch (error) {
            signal?.throwIfAborted();
            if (direct) return direct;
          }
        }
        if (direct) return direct;
        if (kind === 'video')
          return chunked(client, '/message/GetMsgVideo', raw, signal);
        const attrs = xmlAttrs(xml, type === 47 ? 'emoji' : 'img');
        const url =
          kind === 'file'
            ? xmlText(xml, 'cdnattachurl') || xmlText(xml, 'attachid')
            : attrs.cdnmidimgurl || attrs.cdnurl || attrs.cdnthumburl;
        const key = kind === 'file' ? xmlText(xml, 'aeskey') : attrs.aeskey;
        if (!url)
          throw new Error('附件缺少可下载的数据或 CDN 地址，请重新发送原文件');
        if (key)
          return requestBytes(
            client,
            '/message/SendCdnDownload',
            { AesKey: key, FileType: kind === 'file' ? 5 : 1, FileURL: url },
            signal,
          );
        return fetchMedia(url, { signal, allowedHosts: CDN_HOSTS });
      },
    },
  ];
}
