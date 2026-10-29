/** iLink CDN: raw AES-128 key or base64(hex key), AES-ECB with PKCS#7. */
import { createDecipheriv } from 'node:crypto';
import {
  decodeBase64,
  fetchMedia,
  safeName,
  mediaTypeFor,
  MAX_MEDIA_BYTES,
} from './media.js';
const CDN_HOST = 'novac2c.cdn.weixin.qq.com';
export function weixinMediaKey(item) {
  if (item?.aeskey && /^[a-fA-F0-9]{32}$/.test(item.aeskey))
    return Buffer.from(item.aeskey, 'hex');
  const key = decodeBase64(item?.media?.aes_key);
  if (key.length === 16) return key;
  if (key.length === 32 && /^[a-fA-F0-9]{32}$/.test(key.toString('ascii')))
    return Buffer.from(key.toString('ascii'), 'hex');
  throw new Error('微信附件密钥无效');
}
export function decryptMedia(bytes, key) {
  if (key.length !== 16 || !bytes.length || bytes.length % 16)
    throw new Error('微信附件加密数据无效');
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(bytes), decipher.final()]);
  } catch {
    throw new Error('微信附件解密失败，请重新发送');
  }
}
export function mediaUrl(media) {
  if (media?.encrypt_query_param)
    return `https://${CDN_HOST}/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  const url = new URL(media?.full_url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== CDN_HOST ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/c2c/')
  )
    throw new Error('微信附件下载地址不受信任');
  return url.toString();
}
export function weixinAttachments(message, { fetchImpl = fetch } = {}) {
  const sources = [];
  for (const item of message.item_list ?? []) {
    const kind = item.image_item
      ? 'image'
      : item.voice_item
        ? 'audio'
        : item.file_item
          ? 'file'
          : item.video_item
            ? 'video'
            : null;
    if (!kind) continue;
    const value = item[`${kind === 'audio' ? 'voice' : kind}_item`];
    // A transcribed voice item may have no audio media at all.
    if (kind === 'audio' && !value.media && value.text) continue;
    const name = safeName(
      value.file_name,
      kind === 'image'
        ? `image-${sources.length + 1}.jpg`
        : kind === 'audio'
          ? 'voice.silk'
          : kind === 'video'
            ? 'video.mp4'
            : 'file.bin',
    );
    sources.push({
      kind,
      name,
      mediaType: mediaTypeFor(name),
      transcript: kind === 'audio' ? value.text : '',
      size: Number(value.len) || undefined,
      async load({ signal, maxBytes = MAX_MEDIA_BYTES } = {}) {
        const key = weixinMediaKey(value);
        const url = mediaUrl(value.media);
        const bytes = await fetchMedia(url, {
          signal,
          fetchImpl,
          allowedHosts: [CDN_HOST],
          maxBytes: maxBytes + 16,
        });
        signal?.throwIfAborted();
        return decryptMedia(bytes, key);
      },
    });
  }
  return sources;
}
