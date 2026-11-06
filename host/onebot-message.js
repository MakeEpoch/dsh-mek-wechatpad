import { mediaTypeFor, safeName } from './media.js';
import { decodeMessage, cleanupText } from './inbound.js';
/** Decode standard segments first; source is used only for unsupported native messages. */
export function decodeOneBot(event, client) {
  const self = event.self?.user_id;
  const segments = event.message;
  if (!self || !Array.isArray(segments) || !event.message_id) return null;
  const group = event.detail_type === 'group';
  if (!group && event.detail_type !== 'private') return null;
  const parts = [], attachments = [], mentions = [];
  for (const segment of segments) {
    const data = segment.data ?? {};
    if (segment.type === 'text') parts.push(String(data.text ?? ''));
    if (segment.type === 'mention') mentions.push(String(data.user_id ?? ''));
    if (segment.type === 'mention_all') mentions.push('*');
    if (['image', 'voice', 'audio', 'video', 'file'].includes(segment.type) && data.file_id) {
      const kind = ['voice', 'audio'].includes(segment.type) ? 'audio' : segment.type;
      const descriptor = { kind, name: safeName(`${data.file_id}.${kind === 'audio' ? 'silk' : kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'bin'}`),
        async load({ signal } = {}) {
          const response = await client.request('get_file', { file_id: data.file_id, type: 'data' }, { signal, timeoutMs: 120_000 });
          if (!response.ok || typeof response.data?.data !== 'string') throw new Error(response.error || '附件数据无效');
          descriptor.name = safeName(response.data.name || descriptor.name); descriptor.mediaType = mediaTypeFor(descriptor.name);
          return Buffer.from(response.data.data, 'base64');
        } };
      descriptor.mediaType = mediaTypeFor(descriptor.name); attachments.push(descriptor);
    }
  }
  if (!parts.length && !attachments.length) {
    const native = event['wechat.source']?.data;
    if (native && segments.some(s => s.type === 'wechat.native')) {
      const message = decodeMessage(native, { selfWxid: self });
      if (message) { message.messageId = String(event.message_id); message.senderId = String(event.user_id); }
      return message;
    }
    return null;
  }
  return { messageId: String(event.message_id), chatId: group ? String(event.group_id ?? '') : String(event.user_id ?? ''),
    senderId: String(event.user_id ?? ''), text: cleanupText(parts.join('')), contextText: group ? parts.join('').trim() : '', otherMentionOnly: group && mentions.length > 0 && !mentions.includes(self) && !mentions.includes('*'), isGroup: group, mentioned: mentions.includes(self) || mentions.includes('*'),
    rawAtUsers: mentions, msgType: attachments[0]?.kind === 'image' ? 3 : attachments[0]?.kind === 'audio' ? 34 : attachments[0] ? 49 : 1,
    createdAt: Number(event.time) * 1000, attachments, source: event['wechat.source'] };
}
