/** WS feed shared with the server's independent Webhook delivery. */
export function buildPadWsUrl({ baseUrl, token, wxid, clientId = 'dsh' }) {
  if (!token || !wxid) throw new Error('需要访问 Token 和机器人 wxid');
  if (/[,，\s]/.test(wxid)) throw new Error('一个连接只能填写一个机器人 wxid');
  const url = new URL('/ws/outbound', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址需要 http 或 https');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('wxids', wxid);
  return url.toString();
}

export function unwrapPadFrame(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const type = String(payload.type ?? '').toLowerCase();
  if (type === 'message') return { wxid: String(payload.wxid ?? '').trim(), message: payload.message ?? null };
  if (['ping', 'pong', 'auth_ok', 'subscribe_ok'].includes(type)) return { control: type };
  if (['warning', 'error'].includes(type)) return { control: type, detail: String(payload.detail ?? payload.message ?? payload.error ?? '') };
  return null;
}
