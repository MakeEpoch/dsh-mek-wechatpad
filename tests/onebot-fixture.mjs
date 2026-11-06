export function eventFromNative(wxid, raw) {
  const string = x => typeof x === 'string' ? x : x?.str || '';
  const from = string(raw.from_user_name), to = string(raw.to_user_name);
  const group = from.endsWith('@chatroom') || to.endsWith('@chatroom');
  let body = string(raw.content), user = from;
  if (from.endsWith('@chatroom') && body.includes(':\n')) { const i = body.indexOf(':\n'); user = body.slice(0, i); body = body.slice(i + 2); }
  const message = [];
  const source = String(raw.msg_source || '');
  const users = source.match(/<atuserlist>(?:<!\[CDATA\[)?([^<\]]+)/)?.[1]?.split(',') || [];
  for (const user_id of users) message.push({ type: 'mention', data: { user_id } });
  if (Number(raw.msg_type) === 1) message.push({ type: 'text', data: { text: body } });
  else message.push({ type: 'wechat.native', data: { message_type: raw.msg_type } });
  return { id: `${wxid}:${raw.new_msg_id}`, time: raw.create_time || Date.now()/1000, type: 'message', detail_type: group ? 'group' : 'private', sub_type: '',
    self: { platform: 'wechat', user_id: wxid }, message_id: String(raw.new_msg_id || raw.msg_id), user_id: user, ...(group ? { group_id: from.endsWith('@chatroom') ? from : to } : {}),
    message, alt_message: body, 'wechat.source': { provider: 'fixture', data: raw } };
}
export function actionReply(body, data, retcode = 0, message = '') { return { status: retcode ? 'failed' : 'ok', retcode, data, message, echo: body.echo }; }
export async function fakeProviderHttp(request, response, sent) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const p = body.params ?? {};
  let data = {};
  if (body.action === 'get_self_info') data = { user_id: body.self.user_id, user_name: 'Bot', user_displayname: '' };
  else if (body.action === 'get_status') data = { good: true, bots: [{ self: body.self, online: true }] };
  else if (body.action === 'send_message') {
    sent.push({ ToUserName: p.group_id || p.user_id, TextContent: p.message.filter(s => s.type === 'text').map(s => s.data.text).join(''), MsgType: 1 });
    data = { message_id: String(sent.length), time: Date.now()/1000 };
  }
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(actionReply(body, data)));
}
