/** OneBot v12 event feed; account filtering uses self, not a private subscription command. */
export function buildPadWsUrl({ baseUrl }) {
  const url = new URL('/', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址需要 http 或 https');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
export function unwrapPadFrame(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type === 'meta') return { control: payload.detail_type };
  if (payload.type !== 'message' || payload.self?.platform !== 'wechat' || !Array.isArray(payload.message)) return null;
  return { wxid: payload.self.user_id, message: payload };
}
