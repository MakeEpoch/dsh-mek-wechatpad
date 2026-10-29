/**
 * Browser half of `@dsh/wechatpad`: the "设置 → 微信" page.
 *
 * dsh's Settings shell owns the panel chrome; this module contributes one
 * section through the official `settings.section` slot. The component is a
 * plain React function component with no runtime downloads: React and JSX
 * arrive from dsh itself, exactly like the bundled settings pages.
 *
 * Connection, session and access settings are independent tabs. One connection
 * selector chooses Pad or Bridge; iLink is independently enabled.
 * Changes stay local until explicitly saved; runtime actions use saved settings.
 *
 * Everything it shows comes from the Host over the plugin's own RPC channel —
 * status, a redacted settings read model, and a connection test.
 * Writing goes back through the same channel, which forwards to the
 * dsh Settings service, so the profile patch stays the only source of truth.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { installConversationGroups } from './conversation-groups.js';

// Connection composes the request URL as `${channel}/${endpoint}`, so the
// endpoint must NOT carry a leading slash — `/api` + `//x` would be a
// different path. The Host side declares its own absolute path.
const RPC_ENDPOINT = 'dsh-wechatpad';
const LOCALE_NAMESPACE = 'wechatpad';
/** Where the selected tab is remembered. An unknown value falls back to `pad`. */
const TAB_STORAGE_KEY = 'dsh-wechatpad:tab';
/** Tab ids in display order; the first one is the default and the fallback. */
const TABS = ['pad', 'weixin', 'session', 'access'];
/** Host RPC names for the iLink login flow (management channel). */
const LOGIN_BEGIN = 'weixin.login.begin';
const LOGIN_POLL = 'weixin.login.poll';
const LOGIN_CANCEL = 'weixin.login.cancel';
const ACCOUNT_RESET = 'weixin.account.reset';
/** How often the panel asks the Host what the QR scan is doing. */
const LOGIN_POLL_MS = 1000;
/** Only WeChat's own TLS hosts may be rendered as an <img src>. */
const QR_HOST_SUFFIXES = ['weixin.qq.com', 'wechat.com'];
/** Login states after which polling stops on its own. */
const TERMINAL_LOGIN_STATES = new Set(['expired', 'verify_verifycode_blocked']);

const CSS = `
.wxp{width:100%;max-width:760px;min-width:0;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:20px}
.wxp *,.wxp *::before,.wxp *::after{box-sizing:border-box}
.wxp h2{margin:0;font-size:18px;font-weight:600;line-height:26px}
.wxp p{margin:0;color:var(--dsw-alias-label-tertiary)}
.wxp-card{border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-l1)}
.wxp-cardHead{display:flex;align-items:center;gap:8px;justify-content:space-between}
.wxp-cardTitle{font-size:14px;font-weight:600}
.wxp-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font-size:12px;border:0.5px solid var(--dsw-alias-border-l2)}
.wxp-pill[data-phase="connected"]{color:var(--dsw-alias-state-success-primary,#3a9b6c)}
.wxp-pill[data-phase="idle"]{color:var(--dsw-alias-label-secondary)}
.wxp-pill[data-phase="error"]{color:var(--dsw-alias-state-error-primary,#c5524a)}
.wxp-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.wxp-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px 16px}
.wxp-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.wxp-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wxp-field small{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wxp input[type=text],.wxp input[type=password],.wxp input[type=number],.wxp select,.wxp textarea{
  font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l2);
  border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 9px;min-width:0;width:100%}
.wxp textarea{resize:vertical;min-height:56px;font-family:inherit}
.wxp input:focus-visible,.wxp select:focus-visible,.wxp textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a6cf7);outline-offset:1px}
.wxp-switch{display:flex;align-items:center;gap:8px}
.wxp-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wxp button{font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:6px 14px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l2);border:0.5px solid var(--dsw-alias-border-l2)}
.wxp button[data-kind=primary]{background:var(--dsw-alias-state-business-primary,#4a6cf7);border-color:transparent;color:#fff}
.wxp button:disabled{opacity:.55;cursor:not-allowed}
.wxp-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wxp-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#c5524a)}
.wxp-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#3a9b6c)}
.wxp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.wxp-row:last-child{border-bottom:0}
.wxp-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.wxp-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2147483000;padding:20px;box-sizing:border-box}
.wxp-dialog{background:var(--dsw-alias-bg-l1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:0.5px solid var(--dsw-alias-border-l2,#ddd);border-radius:14px;padding:18px 20px;max-width:720px;width:100%;max-height:min(78vh,640px);overflow:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 18px 48px rgba(0,0,0,.45);box-sizing:border-box}
.wxp-table{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}
.wxp-tableHead,.wxp-tableRow{display:grid;grid-template-columns:minmax(0,2.4fr) 100px 70px 104px;gap:10px;align-items:center;padding:8px 12px}
.wxp-tableHead{background:var(--dsw-alias-bg-l2);font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.wxp-tableRow{border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.wxp-tableRow:last-child{border-bottom:0}
.wxp-banner{border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.wxp-advanced>summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.wxp-advanced[open]>.wxp-grid{margin-top:12px}
.wxp-advanced{border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:12px}
/* The tab strip is a set of buttons inside .wxp, so every rule below has to
   outrank the generic .wxp button card-button styling. */
.wxp .wxp-tabs{display:flex;gap:4px;border-bottom:0.5px solid var(--dsw-alias-border-l2);overflow-x:auto;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
.wxp .wxp-tab{flex:0 0 auto;white-space:nowrap;font:inherit;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:none;border:0;border-bottom:2px solid transparent;border-radius:0;padding:7px 12px;margin-bottom:-0.5px}
.wxp .wxp-tab:hover{color:var(--dsw-alias-label-primary)}
.wxp .wxp-tab[aria-selected=true]{color:var(--dsw-alias-state-business-primary,#4a6cf7);border-bottom-color:var(--dsw-alias-state-business-primary,#4a6cf7);font-weight:600}
.wxp .wxp-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a6cf7);outline-offset:-2px;border-radius:6px}
.wxp-tabpanel{display:flex;flex-direction:column;gap:16px}
.wxp-tabpanel[hidden]{display:none}
.wxp-qr{width:180px;height:180px;border-radius:10px;background:#fff;padding:8px;box-sizing:border-box;object-fit:contain;border:0.5px solid var(--dsw-alias-border-l2)}
.wxp-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.wxp-connectionStatus{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.wxp-footer{position:sticky;bottom:0;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;background:var(--dsw-alias-bg-l1,#fff);border-top:0.5px solid var(--dsw-alias-border-l2);margin-top:4px}
.wxp-footer .wxp-hint{flex:1}
.wxp .wxp-secondary{background:transparent}
.wxp-feedback{display:flex;flex-direction:column;gap:6px}
.wxp input,.wxp select{min-height:36px}
.wxp button:focus-visible,.wxp summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a6cf7);outline-offset:2px}
@media(max-width:560px){.wxp-grid{grid-template-columns:minmax(0,1fr)}.wxp-header{align-items:flex-start}.wxp-footer{flex-wrap:wrap}.wxp-tableHead,.wxp-tableRow{grid-template-columns:minmax(0,1fr) 70px 48px 94px;gap:6px;padding:8px}.wxp-dialog{padding:14px}.wxp-backdrop{padding:10px}}
.wxp-bot{display:flex;flex-direction:column;gap:6px;min-width:0}
`;

/** Install the section stylesheet once per document. */
function useSectionStyles() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const id = 'dsh-wechatpad-settings';
    let tag = document.querySelector(`style[data-dsh-css="${id}"]`);
    if (!tag) {
      tag = document.createElement('style');
      tag.dataset.dshCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    setReady(true);
    return () => { /* the stylesheet is shared by every mount */ };
  }, []);
  return ready;
}

/** Call one management endpoint; unwraps the Remote result envelope. */
async function callRpc(connection, method, payload, signal) {
  // The host mounts this channel on dsh's shared /api carrier; Connection adds
  // the request/response correlation and validates the envelope for us.
  let response;
  try {
    response = await connection.rpc.call('/api', RPC_ENDPOINT, { method, payload }, signal);
  } catch (cause) {
    if (signal?.aborted || cause?.name === 'AbortError') throw cause;
    const error = new Error('无法访问 dsh 管理接口，请刷新页面后重试。', { cause });
    error.code = 'wechatpad/unreachable';
    throw error;
  }
  const result = response?.result ?? response;
  if (result && result.ok === false) {
    const error = new Error(result.error?.message || '调用失败');
    error.code = result.error?.code;
    throw error;
  }
  return result?.value ?? result;
}

/**
 * May this URL be rendered as the QR <img src>?
 *
 * The URL comes from the Host, but a compromised or misconfigured endpoint
 * could hand back anything, and an <img> would then point the panel's origin
 * at a third party (a `javascript:` URL is a script injection). Only https on
 * WeChat's own domains qualifies; anything else renders as a plain link the
 * user may click deliberately.
 * @param {unknown} raw candidate URL from the Host.
 * @returns {string | null} the URL when it is safe, else null.
 */
export function safeQrUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  // The match must be domain-bounded: `evil-weixin.qq.com.attacker.io` would
  // pass an endsWith on the full host, and `notweixin.qq.com` would pass a
  // substring check. Require the host to BE a suffix or a subdomain of one.
  if (!QR_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  return url.toString();
}

/** Reduce a bot identifier to a display value that is never the full secret. */
export function maskBotId(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text.length <= 6) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 4)}***${text.slice(-2)}`;
}

/** Format a Host timestamp (epoch ms or ISO string) for display. */
function formatStamp(raw) {
  if (!raw) return '—';
  const value = typeof raw === 'number' ? raw : Date.parse(String(raw));
  if (!Number.isFinite(value)) return String(raw);
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Read the remembered tab, falling back when storage is unavailable or wrong. */
function readStoredTab() {
  try {
    const value = globalThis.localStorage?.getItem(TAB_STORAGE_KEY);
    return TABS.includes(value) ? value : TABS[0];
  } catch {
    return TABS[0];
  }
}

/** Remember the selected tab; a sandboxed storage must not break the page. */
function storeTab(id) {
  try {
    globalThis.localStorage?.setItem(TAB_STORAGE_KEY, id);
  } catch {
    /* private mode / denied storage: the tab simply does not persist */
  }
}

const EN = {
  title: '微信',
  intro: '通过 WechatPad、WeChat Bridge 或扫码绑定腾讯 iLink 机器人，把微信接入 dsh。微信消息会进入真实会话，回复也回到同一个聊天。',
  tabsLabel: '微信设置分区',
  tabPad: 'WechatPad',
  tabWeixin: '微信机器人',
  tabSession: '会话',
  tabAccess: '访问控制',
  providerLabel: '微信接入方式',
  providerHint: '决定消息如何进入 dsh；切换后保存即按新接入方式重载。',
  providerPad: 'WechatPad：直连 Pad / WeChat Bridge',
  providerWeixin: '微信机器人：扫码绑定腾讯 iLink，无需 Pad',
  providerCurrent: '当前接入方式',
  providerPadShort: 'WechatPad',
  providerWeixinShort: '微信机器人',
  providerReloading: '已保存，正在更新连接…',
  weixinBind: '扫码绑定',
  weixinBindHint: '用微信扫码并在手机上确认。',
  weixinGenerate: '生成二维码',
  weixinGenerating: '正在生成…',
  weixinCancel: '取消',
  weixinStateWait: '等待扫码',
  weixinStateScaned: '已扫码，请在手机上确认',
  weixinStateConfirmed: '绑定成功',
  weixinStateExpired: '二维码已过期，请重新生成',
  weixinStateNeedVerifycode: '需要在本页输入配对码',
  weixinStateBlocked: '验证被拦截，请稍后重试或改用 WechatPad',
  weixinStateUnknown: '状态未知',
  weixinVerifyCode: '配对码',
  weixinVerifyCodeHint: '手机上显示的配对码；提交后会自动重新生成二维码。',
  weixinVerifySubmit: '提交配对码',
  weixinQrAlt: '微信绑定二维码',
  weixinQrUnavailable: '二维码地址未通过校验，请点击下面的链接打开。',
  weixinBound: '已绑定',
  weixinBotId: '机器人标识',
  weixinBoundAt: '绑定时间',
  weixinUnbind: '解除绑定',
  weixinUnbinding: '正在解除…',
  weixinUnbound: '已解除绑定',
  weixinUnboundHint: '未绑定',
  weixinTyping: '等待回答时显示「正在输入」',
  weixinReplyQuote: '把被引用的消息一并交给模型',
  weixinBotType: '机器人类型',
  weixinBotTypeHint: '扫码机器人类型，普通用户请勿修改。',
  weixinAccountFile: '账号数据目录',
  weixinAccountFileHint: '留空使用默认目录',
  weixinManagedHint: '',
  discard: '放弃更改',
  unsaved: '有未保存的更改',
  upToDate: '所有更改已保存',
  saveConnect: '保存并连接',
  saveBeforeAction: '请先保存或放弃连接配置的更改。',
  saveBeforeLogin: '启用并保存后，即可扫码绑定。',
  weixinAdvanced: '回复设置',
  status: '状态',
  connection: '连接',
  baseUrl: 'WechatPad 地址',
  baseUrlHint: '',
  key: 'Key',
  keyHint: '',
  keySaved: '已设置，留空保留',
  apiPrefix: '接口前缀',
  apiPrefixHint: '留空直连 WechatPad；填 /proxy 经 Bridge 代理，需要同时填写 wxid',
  wxid: '机器人 wxid',
  wxidHint: '仅 Bridge 代理模式需要',
  receiveMode: '接收方式',
  receiveWebsocket: 'WebSocket 推送（推荐）',
  receiveWebhook: 'HTTP 回调',
  receiveBridge: 'WeChat Bridge 订阅',
  bridgeConnectionHint: '收消息使用 Bridge 订阅，发消息也通过 Bridge；可与其他消费者并行。',
  webhookPath: '回调路径',
  webhookPathHint: '插件会将此路径自动登记到 WechatPad；WechatPad 需要能访问 dsh 的 Web 地址。',
  bridgeBaseUrl: 'Bridge 地址',
  bridgeBaseUrlHint: '',
  bridgeToken: 'Bridge token',
  bridgeTokenHint: '',
  bridgeAccounts: '机器人 wxid',
  bridgeAccountsHint: '填写机器人自己的 wxid，多个账号用逗号分隔。',
  bridgeClientId: '客户端标识',
  bridgeClientIdHint: '同一 Bridge 上的客户端标识不能重复。',
  requestTimeout: '请求超时（秒）',
  test: '检测连接',
  testOk: '连接正常',
  testFail: '连接失败',
  reconnect: '重新连接',
  saving: '保存中…',
  save: '保存更改',
  reset: '恢复默认',
  saved: '已保存',
  savedReloading: '已保存，正在确认配置…',
  session: '会话',
  cwd: '工作目录',
  cwdHint: '留空按聊天使用 ~/.dsh/wechat/<chatId>',
  preset: 'Agent Preset',
  presetHint: '留空使用 dsh 默认预设',
  titlePrefix: '会话标题前缀',
  replyChunk: '回复分段长度',
  mergeReplies: '合并一轮回复后发送',
  showProgress: '发送运行进度',
  mergeDelay: '消息合并等待时间（秒）',
  mergeDelayHint: '0 表示不合并；从最后一条消息开始计时。',
  incomingMode: '新消息处理方式',
  incomingModeHint: '打断会停止当前任务，已排队消息保留。',
  incomingQueue: '排队：等当前任务完成',
  incomingInterrupt: '打断：停止当前任务',
  access: '访问控制',
  dmPolicy: '私聊',
  groupPolicy: '群聊',
  policyOpen: '全部响应',
  policyAllowlist: '仅白名单',
  policyDisabled: '忽略',
  allowedUsers: '私聊白名单',
  allowedUsersHint: '填写 wxid，逗号或换行分隔',
  allowedGroups: '群白名单',
  allowedGroupsHint: '填写群 ID，逗号或换行分隔',
  groupMention: '群聊需 @ 机器人才响应',
  selfWxid: '机器人 wxid（用于忽略自己的消息）',
  commandPrefix: '命令前缀',
  seenGroups: '发现群聊',
  seenGroupsHint: '加入白名单后保存生效。',
  seenGroupsEmpty: '暂无群聊，收到群消息后会显示在这里。',
  seenGroupsSummary: '已发现 {count} 个群',
  openGroups: '查看群聊',
  close: '关闭',
  groupColumn: '群 ID',
  groupLastAt: '最后消息',
  groupCount: '消息数',
  groupAction: '操作',
  addToGroups: '加入白名单',
  alreadyAllowed: '已在白名单',
  addedToGroups: '已加入群白名单，记得保存',
  remote: '远程配置入口',
  remoteHint: '本插件也出现在「设置 → 插件 → 可配置插件」中，两处修改等价。',
  advanced: '高级设置',
  enablePlugin: '启用插件',
  settingsUnavailable: '当前 profile 没有启用 dsh 设置服务，无法在此保存；请用「设置 → 插件」的配置表单。',
  settingsDiagnostic: '配置表单状态未就绪（仍可尝试保存）：',
  routeMode: 'Pad 接入方式',
  direct: '直连 WechatPad',
  bridge: 'WeChat Bridge',
  legacyProxy: '旧版 Bridge 代理配置',
  legacyProxyHint: '此配置保留旧版代理行为。请选择“直连 WechatPad”或“WeChat Bridge”，填写对应信息后保存。',
  legacyBaseUrl: '旧版代理地址',
  loading: '正在读取…',
};

const ZH = { ...EN, $locale: 'zh' };

/** Tab id → dictionary key for its label. */
const TAB_LABELS = { pad: 'tabPad', weixin: 'tabWeixin', session: 'tabSession', access: 'tabAccess' };
/**
 * Login state → dictionary key for its label.
 *
 * The Host speaks the iLink names; `verify_code_blocked` is the protocol's own
 * spelling while the settings spec calls it `verify_verifycode_blocked`, and
 * `scaned_but_redirect` is a transient wait state, so both spellings map here.
 */
const LOGIN_STATE_LABELS = {
  wait: 'weixinStateWait',
  scaned: 'weixinStateScaned',
  scaned_but_redirect: 'weixinStateScaned',
  confirmed: 'weixinStateConfirmed',
  expired: 'weixinStateExpired',
  need_verifycode: 'weixinStateNeedVerifycode',
  verify_code_blocked: 'weixinStateBlocked',
  verify_verifycode_blocked: 'weixinStateBlocked',
  binded_redirect: 'weixinStateConfirmed',
};

/**
 * Pull the login fields out of a begin/poll result.
 *
 * Two names are in circulation on the Host side — the connection adapter's
 * `attemptId`/`status` and the panel contract's `ticket`/`state` — so accept
 * both rather than rendering a silent "wait" forever.
 * @param {Record<string, unknown> | null | undefined} raw Host result.
 */
function readLoginResult(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  if (source.supported === false || source.error) {
    throw new Error(String(source.error || source.detail || '当前连接不支持扫码绑定'));
  }
  const state = source.state ?? source.status;
  return {
    ticket: source.ticket ?? source.attemptId,
    qrcodeImage: typeof source.qrcodeImage === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(source.qrcodeImage) && source.qrcodeImage.length < 100000 ? source.qrcodeImage : '',
    qrcodeUrl: source.qrcodeUrl ?? source.qrCodeUrl ?? source.qrcode ?? '',
    state: typeof state === 'string' ? state : 'wait',
    account: source.account && typeof source.account === 'object' ? source.account : null,
    error: source.error ? String(source.error) : '',
  };
}

/**
 * Read the bound-bot summary from the status read model.
 *
 * The service may flatten the adapter's status into `status()` or nest it
 * under `providerStatus`; both are accepted, and only masked values are ever
 * rendered.
 * @param {Record<string, any>} status Host status payload.
 * @param {Record<string, any>} settings settings read model.
 */
function readBinding(status, settings) {
  const nested = status?.providerStatus && typeof status.providerStatus === 'object' ? status.providerStatus : {};
  const botId = maskBotId(
    status?.weixinBotId ?? status?.botId ?? nested.botName ?? nested.botId
    ?? status?.weixin?.botName ?? settings?.weixinBotId ?? settings?.botId,
  );
  const boundAt = status?.weixinBoundAt ?? status?.boundAt ?? nested.connectedAt ?? nested.boundAt
    ?? status?.weixin?.boundAt ?? settings?.weixinBoundAt;
  const explicit = typeof status?.weixinBound === 'boolean' ? status.weixinBound : undefined;
  return {
    botId,
    boundAt,
    bound: explicit ?? Boolean(botId) ?? false,
  };
}

/**
 * t() over the locale service.
 *
 * `translate(key)` resolves the key through the active dictionary. If the
 * service hands the key straight back — an unknown key, or an embedder that
 * binds without dictionaries, which is how a test harness or a minimal shell
 * behaves — fall back to this module's own source text so the page never
 * renders raw keys such as `tabWeixin` to a user.
 * @param {(key: string) => string} translate locale service binding.
 */
function createTranslator(translate) {
  const source = (key) => (Object.hasOwn(EN, key) ? EN[key] : key);
  return (key, vars) => {
    let text = translate(key);
    if (text === key) text = source(key);
    if (vars) for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
}

function Field({ label, hint, children }) {
  return React.createElement('label', { className: 'wxp-field' },
    React.createElement('span', null, label),
    children,
    hint ? React.createElement('small', null, hint) : null);
}

function Toggle({ label, checked, disabled, onChange }) {
  return React.createElement('label', { className: 'wxp-switch' },
    React.createElement('input', {
      type: 'checkbox', checked: Boolean(checked), disabled,
      onChange: (event) => onChange(event.target.checked),
    }),
    React.createElement('span', null, label));
}

/**
 * Bind a text-like control to the draft.
 *
 * Both events are wired on purpose: `input` covers every real keystroke,
 * paste and IME commit, while `change` is the fallback for a host that
 * synthesizes only that one. Both write the same value, so a double fire is a
 * no-op assignment.
 */
function bindText(set, field, transform = (value) => value) {
  const handler = (event) => set(field, transform(event.target.value));
  return { onInput: handler, onChange: handler };
}

/**
 * Human-friendly "how long ago" for a group's last message. A bare numeric
 * chatroom id carries no identity, so the time is what tells two groups apart.
 * @param {number} stamp epoch milliseconds, or 0 when unknown.
 */
function formatRelative(stamp) {
  if (!stamp) return '—';
  const delta = Date.now() - stamp;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  const days = Math.floor(delta / 86_400_000);
  if (days < 30) return `${days} 天前`;
  const date = new Date(stamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Split a textarea into the string array the Host expects. */
function toList(text) {
  return String(text ?? '').split(/[,，\s]+/).map((part) => part.trim()).filter(Boolean);
}

/**
 * The tab bar: `role=tablist` with roving tabindex, so Left/Right (plus Home
 * and End) move between tabs exactly as a keyboard user expects.
 */
function TabBar({ tabs, active, t, onSelect }) {
  // Focus is moved by ref rather than by selector so a synthetic click and a
  // key press land on the same element the React tree considers selected.
  const refs = React.useRef({});
  const focusTab = (id) => {
    const node = refs.current[id];
    // jsdom and some embedders have no real focus(); the selection still moves.
    node?.focus?.();
  };
  const select = (id) => {
    onSelect(id);
    focusTab(id);
  };
  const step = (delta) => {
    const index = tabs.indexOf(active);
    select(tabs[(index + delta + tabs.length) % tabs.length]);
  };
  return React.createElement('div', {
    className: 'wxp-tabs',
    role: 'tablist',
    'aria-label': t('tabsLabel'),
    onKeyDown: (event) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
      else if (event.key === 'Home') { event.preventDefault(); select(tabs[0]); }
      else if (event.key === 'End') { event.preventDefault(); select(tabs[tabs.length - 1]); }
    },
  }, tabs.map((id) => React.createElement('button', {
    key: id,
    type: 'button',
    role: 'tab',
    id: `wxp-tab-${id}`,
    className: 'wxp-tab',
    'data-tab': id,
    'aria-selected': active === id ? 'true' : 'false',
    'aria-controls': `wxp-panel-${id}`,
    tabIndex: active === id ? 0 : -1,
    ref: (node) => { refs.current[id] = node; },
    onClick: () => select(id),
  }, t(TAB_LABELS[id]))));
}

/**
 * The settings page itself. It receives `{ close }` from dsh's Settings shell;
 * a section never owns its own visibility.
 */
export function WechatPadSettings({ t, connection, locale }) {
  useSectionStyles();
  const [model, setModel] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [seenGroups, setSeenGroups] = React.useState([]);
  const [notificationChats, setNotificationChats] = React.useState([]);
  const [groupsOpen, setGroupsOpen] = React.useState(false);
  const [tab, setTab] = React.useState(readStoredTab);
  const [draft, setDraft] = React.useState({});
  const [keyDraft, setKeyDraft] = React.useState('');
  const [bridgeTokenDraft, setBridgeTokenDraft] = React.useState('');
  const [users, setUsers] = React.useState('');
  const [groups, setGroups] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [notice, setNotice] = React.useState(null);
  const [error, setError] = React.useState('');
  // The iLink login lives only while the panel is mounted and a ticket exists.
  const [login, setLogin] = React.useState(null);
  const [verifyCode, setVerifyCode] = React.useState('');
  const alive = React.useRef(true);
  const directReceiveMode = React.useRef('websocket');
  // The poll must not restart on every state change, so the ticket the current
  // session owns is kept in a ref and the interval depends on its identity.
  const loginTicket = React.useRef(null);

  React.useEffect(() => {
    alive.current = true;
    return () => {
    alive.current = false;
    // Never leave the Host holding an abandoned login session.
    const ticket = loginTicket.current;
    loginTicket.current = null;
    if (ticket) void callRpc(connection, LOGIN_CANCEL, { ticket }).catch(() => {});
    };
  }, [connection]);

  const refresh = React.useCallback(async (options = {}) => {
    const controller = new AbortController();
    try {
      const [settings, currentStatus, groups, conversations] = await Promise.all([
        callRpc(connection, 'settings.get', {}, controller.signal),
        callRpc(connection, 'status.get', {}, controller.signal),
        callRpc(connection, 'groups.seen', {}, controller.signal).catch(() => ({ items: [] })),
        callRpc(connection, 'conversations.list', {}, controller.signal).catch(() => ({ items: [] })),
      ]);
      if (!alive.current) return;
      setModel(settings);
      setStatus(currentStatus);
      setSeenGroups(groups?.items ?? []);
      setNotificationChats(conversations?.items ?? []);
      if (!options.keepDraft) {
        setUsers((settings?.settings?.allowedUsers ?? []).join(', '));
        setGroups((settings?.settings?.allowedGroups ?? []).join(', '));
        setDraft({});
        setKeyDraft('');
        setBridgeTokenDraft('');
      }
    } catch (failure) {
      if (alive.current) setError(failure.message || String(failure));
    }
  }, [connection]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  // Re-read only the status line while the page is open; the settings form is
  // left alone so a user's unsaved edits are never overwritten by a poll.
  React.useEffect(() => {
    const timer = setInterval(() => {
      callRpc(connection, 'status.get', {}).then((next) => { if (alive.current) setStatus(next); }).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [connection]);

  // Inputs are controlled from the draft, then the loaded value, then the
  // schema default, so every keystroke reaches React state and an untouched
  // field shows the Host's own default instead of an empty box.
  const base = model?.settings ?? {};
  const defaults = { provider: 'pad', ...(model?.defaults ?? {}) };
  const values = { ...defaults, ...base, ...draft };
  const set = (field, value) => setDraft((previous) => ({ ...previous, [field]: value }));
  // A read-only profile is the only state where saving is genuinely pointless.
  // "Could not describe the form" is a diagnosis, not a verdict: the write path
  // reports its own reason, so the buttons stay available and a failure shows up
  // as a message instead of a dead button.
  const disabled = Boolean(model && model.readable === false && model.reason === 'read-only');
  // The protocol the runtime started with versus the one being edited.
  const savedProvider = base.provider === 'weixin' ? 'weixin' : 'pad';
  const provider = values.provider === 'weixin' ? 'weixin' : 'pad';
  const savedProviders = base.enabledProviders ?? [savedProvider];
  const enabledProviders = values.enabledProviders ?? savedProviders;
  const activeProvider = tab === 'weixin' ? 'weixin' : 'pad';
  const channelStatus = (id) => status?.connections?.[id] ?? (id === savedProvider ? status : null);
  const enabled = (id) => enabledProviders.includes(id);
  const setEnabled = (id, next) => set('enabledProviders', next ? [...new Set([...enabledProviders, id])] : enabledProviders.filter((value) => value !== id));

  const changed = Object.fromEntries(Object.entries(draft).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(base[field] ?? defaults[field])));
  const dirty = Object.keys(changed).length > 0 || Boolean(keyDraft.trim() || bridgeTokenDraft.trim())
    || JSON.stringify(toList(users)) !== JSON.stringify(base.allowedUsers ?? [])
    || JSON.stringify(toList(groups)) !== JSON.stringify(base.allowedGroups ?? []);
  const connectionFields = ['enabledProviders', 'receiveMode', 'apiPrefix', 'baseUrl', 'wxid', 'bridgeBaseUrl', 'bridgeAccounts', 'bridgeClientId', 'webhookPath', 'requestTimeoutSeconds', 'weixinBotType', 'weixinAccountFile'];
  const padDirty = ['receiveMode', 'apiPrefix', 'baseUrl', 'wxid', 'bridgeBaseUrl', 'bridgeAccounts', 'bridgeClientId', 'webhookPath', 'requestTimeoutSeconds'].some((field) => Object.hasOwn(changed, field)) || Boolean(keyDraft.trim() || bridgeTokenDraft.trim()) || enabled('pad') !== savedProviders.includes('pad');
  const weixinDirty = ['weixinBotType', 'weixinAccountFile'].some((field) => Object.hasOwn(changed, field)) || enabled('weixin') !== savedProviders.includes('weixin');
  const channelDirty = activeProvider === 'weixin' ? weixinDirty : padDirty;
  const connectionDirty = connectionFields.some((field) => Object.hasOwn(changed, field)) || Boolean(keyDraft.trim() || bridgeTokenDraft.trim());
  const discard = () => {
    setDraft({}); setKeyDraft(''); setBridgeTokenDraft('');
    setUsers((base.allowedUsers ?? []).join(', ')); setGroups((base.allowedGroups ?? []).join(', '));
    setError(''); setNotice(null);
  };

  const save = async () => {
    const snapshot = { ...changed };
    if (disabled || busy || !model || loginTicket.current) return false;
    setBusy('save'); setError(''); setNotice(null);
    try {
      // Save only changed values. Navigation never stages protocol changes.
      const patch = { ...snapshot };

      if (users !== (model?.settings?.allowedUsers ?? []).join(', ')) patch.allowedUsers = toList(users);
      if (groups !== (model?.settings?.allowedGroups ?? []).join(', ')) patch.allowedGroups = toList(groups);
      if (users === (model?.settings?.allowedUsers ?? []).join(', ') && groups === (model?.settings?.allowedGroups ?? []).join(', ')) {
        delete patch.allowedUsers;
        delete patch.allowedGroups;
      }
      if (keyDraft.trim()) patch.key = keyDraft.trim();
      if (bridgeTokenDraft.trim()) patch.bridgeToken = bridgeTokenDraft.trim();
      // An undescribed form has no revision to compare against; the host then
      // resolves the current one instead of sending a stale expectation.
      await callRpc(connection, 'settings.update', { patch, expectedRevision: model?.revision });
      const switchingProvider = provider !== savedProvider;
      if (alive.current) {
        // The Host reconciles volatile config in place. Keep the submitted
        // draft until the persisted values have been independently read back.
        setModel((current) => (current ? { ...current, revision: undefined } : current));
        setNotice(switchingProvider ? t('providerReloading') : t('savedReloading'));
      }
      // Read back the settings revision that actually accepted the save. A
      // settings transition can briefly serve an old model; keep the draft until confirmed.
      let confirmed = false;
      for (let attempt = 0; attempt < 5 && alive.current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 350 : 650));
        try {
          const next = await callRpc(connection, 'settings.get', {});
          if (!Object.entries(patch).every(([field, value]) => field === 'key' || field === 'bridgeToken'
            ? next.settings?.[`${field}Configured`] === true
            : JSON.stringify(next.settings?.[field]) === JSON.stringify(value))) continue;
          setModel(next); setDraft({}); setKeyDraft(''); setBridgeTokenDraft('');
          setUsers((next.settings?.allowedUsers ?? []).join(', '));
          setGroups((next.settings?.allowedGroups ?? []).join(', '));
          setNotice(t('saved')); confirmed = true; break;
        } catch { /* the plugin can briefly disappear while reloading */ }
      }
      if (!confirmed && alive.current) setError('保存后未能确认配置，请刷新后核对。');
    } catch (failure) {
      if (alive.current) setError(failure.message || String(failure));
    } finally {
      if (alive.current) setBusy('');
    }
  };

  const test = async () => {
    if (busy || channelDirty) return;
    setBusy('test'); setError(''); setNotice(null);
    try {
      const result = await callRpc(connection, 'connection.test', { provider: activeProvider });
      if (alive.current) {
        setNotice(result?.ok ? `${t('testOk')}：${result.detail ?? ''}` : `${t('testFail')}：${result?.error ?? ''}`);
      }
    } catch (failure) {
      if (alive.current) setError(failure.message || String(failure));
    } finally {
      if (alive.current) setBusy('');
    }
  };

  const reconnect = async () => {
    if (busy || channelDirty) return;
    setBusy('reconnect'); setError(''); setNotice(null);
    try {
      const next = await callRpc(connection, 'connection.reconnect', { provider: activeProvider });
      if (alive.current) { setStatus(next); setNotice('已重新连接'); }
    } catch (failure) {
      if (alive.current) setError(failure.message || String(failure));
    } finally {
      if (alive.current) setBusy('');
    }
  };

  const beginLogin = async (withCode) => {
    if (busy || weixinDirty || !savedProviders.includes('weixin')) return;
    setBusy('login'); setError(''); setNotice(null);
    try {
      const payload = { botType: values.weixinBotType ?? '3' };
      if (withCode) payload.verifyCode = withCode;
      const result = readLoginResult(await callRpc(connection, LOGIN_BEGIN, payload));
      if (!alive.current) return;
      if (!result.ticket) throw new Error('未能创建扫码会话，请稍后重试');
      loginTicket.current = result.ticket;
      setLogin(result);
      setVerifyCode('');
      if (result.state === 'confirmed') {
        // A Host that binds synchronously (an already-bound account) needs no
        // polling at all.
        loginTicket.current = null;
        setNotice(t('weixinStateConfirmed'));
        await refresh({ keepDraft: true });
      }
    } catch (failure) {
      if (alive.current) {
        setError(failure.message || String(failure));
        setLogin(null);
      }
    } finally {
      if (alive.current) setBusy('');
    }
  };
  // The poll effect and the click handlers need the latest closure without
  // restarting the interval; this indirection keeps them on the same path.
  const beginLoginRef = React.useRef(beginLogin);
  beginLoginRef.current = beginLogin;

  const cancelLogin = async () => {
    const ticket = loginTicket.current;
    loginTicket.current = null;
    setLogin(null);
    setBusy('');
    if (!ticket) return;
    try {
      await callRpc(connection, LOGIN_CANCEL, { ticket });
    } catch (failure) {
      if (alive.current) setError(failure.message || String(failure));
    }
  };

  const unbind = async () => {
    setBusy('unbind'); setError(''); setNotice(null);
    try {
      await callRpc(connection, ACCOUNT_RESET, {});
      if (alive.current) {
        setNotice(t('weixinUnbound'));
        setLogin(null);
        loginTicket.current = null;
      }
      await refresh({ keepDraft: true });
    } catch (failure) {
      if (alive.current) setError(failure.message || String(failure));
    } finally {
      if (alive.current) setBusy('');
    }
  };

  // Poll while a login session is open. The Host owns the state machine; the
  // panel only asks, so an expired QR or a pairing prompt on the phone shows up
  // here within a second without any client-side timing guesswork.
  const loginSession = login?.ticket;
  React.useEffect(() => {
    if (!loginSession) return undefined;
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight || !alive.current || loginTicket.current !== loginSession) return;
      inFlight = true;
      try {
        const next = readLoginResult(await callRpc(connection, LOGIN_POLL, { ticket: loginSession }));
        if (stopped || !alive.current || loginTicket.current !== loginSession) return;
        const state = next.state;
        setLogin((current) => (current && current.ticket === loginSession
          ? { ...current, state, qrcodeUrl: next.qrcodeUrl || current.qrcodeUrl, qrcodeImage: next.qrcodeImage || current.qrcodeImage, error: '' }
          : current));
        if (state === 'confirmed') {
          loginTicket.current = null;
          setLogin((current) => (current && current.ticket === loginSession ? { ...current, state } : current));
          setNotice(t('weixinStateConfirmed'));
          await refresh({ keepDraft: true });
        } else if (TERMINAL_LOGIN_STATES.has(state) || state === 'need_verifycode' || state === 'verify_code_blocked') {
          // Stop asking: expiry and a blocked verification are final, and a
          // pairing code requires the user to act before anything changes.
          loginTicket.current = null;
        }
      } catch (failure) {
        if (stopped || !alive.current) return;
        // A transient poll error is shown beside the QR; the user may retry or
        // cancel, and the next tick clears it when the Host recovers.
        setLogin((current) => (current && current.ticket === loginSession
          ? { ...current, error: failure.message || String(failure) }
          : current));
      } finally { inFlight = false; }
    };
    const timer = setInterval(() => { void tick(); }, LOGIN_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [connection, loginSession, refresh, t]);

  const h = React.createElement;
  const bridgeReceive = values.receiveMode === 'bridge';
  const legacyProxy = !bridgeReceive && Boolean(values.apiPrefix);
  // The Pad connection choice owns both send and receive routing. Keep the wire
  // format compatible with existing profiles: receiveMode=bridge already
  // selects the Bridge for both directions in the Host.
  const changeConnection = (mode) => {
    if (!bridgeReceive) directReceiveMode.current = values.receiveMode === 'webhook' ? 'webhook' : 'websocket';
    setDraft((previous) => ({
      ...previous,
      receiveMode: mode === 'bridge' ? 'bridge' : directReceiveMode.current,
      apiPrefix: '',
    }));
  };
  const providerField = () => h(Field, { label: t('routeMode') },
    h('select', {
      value: bridgeReceive ? 'bridge' : legacyProxy ? 'legacy' : 'direct', name: 'connectionMode',
      onChange: (event) => changeConnection(event.target.value),
    },
    h('option', { value: 'bridge' }, t('bridge')),
    h('option', { value: 'direct' }, t('direct')),
    legacyProxy ? h('option', { value: 'legacy', disabled: true }, t('legacyProxy')) : null));

  const connectionHeader = (id, label) => {
    const live = channelStatus(id);
    const pending = id === 'weixin' ? weixinDirty : padDirty;
    const running = savedProviders.includes(id);
    const blocked = live?.lastIgnored;
    const blockedNow = id === 'pad' && (values.dmPolicy ?? 'allowlist') === 'allowlist' && blocked?.reason === 'dm-not-allowed' && !toList(users).some((entry) => ['*', blocked.senderId, `direct:${blocked.senderId}`].includes(entry));
    return h(React.Fragment, null,
      h('div', { className: 'wxp-cardHead' },
        h(Toggle, { label, checked: enabled(id), disabled: Boolean(busy), onChange: (next) => setEnabled(id, next) }),
        h('span', { className: 'wxp-pill', 'data-phase': live?.phase ?? 'disabled' },
          h('i', { className: 'wxp-dot' }), live?.label ?? '未启用')),
      h('div', { className: 'wxp-connectionStatus' },
        h('span', { className: 'wxp-hint' }, `收 ${live?.messagesIn ?? 0} / 发 ${live?.messagesOut ?? 0}`),
        h('div', { className: 'wxp-actions' },
          h('button', { type: 'button', className: 'wxp-secondary', onClick: test, disabled: !model || Boolean(busy) || pending || !running, title: pending ? t('saveBeforeAction') : undefined }, t('test')),
          h('button', { type: 'button', className: 'wxp-secondary', onClick: reconnect, disabled: !model || Boolean(busy) || pending || !running, title: pending ? t('saveBeforeAction') : undefined }, t('reconnect')))),
      blockedNow ? h('div', { className: 'wxp-banner', role: 'status' },
        h('div', null, '已收到消息，但发送者不在私聊白名单中。'),
        h('div', { className: 'wxp-mono' }, blocked.senderId),
        h('button', { type: 'button', disabled: Boolean(busy), onClick: () => { setUsers([...new Set([...toList(users), blocked.senderId])].join(', ')); setNotice('已加入白名单，保存后生效'); } }, '加入私聊白名单')) : null,
      live?.messagesIgnored ? h('span', { className: 'wxp-hint' }, `已拦截 ${live.messagesIgnored} 条消息`) : null,
      live?.lastError ? h('div', { className: 'wxp-error', role: 'alert' }, live.lastError) : null);
  };

  const padPanel = () => h(React.Fragment, null,
      h('div', { className: 'wxp-grid' },
        !bridgeReceive ? h(Field, { label: t(legacyProxy ? 'legacyBaseUrl' : 'baseUrl'), hint: legacyProxy ? undefined : t('baseUrlHint') },
          h('input', {
            type: 'text', value: values.baseUrl ?? '', spellCheck: false, name: 'baseUrl',
            ...bindText(set, 'baseUrl'),
          })) : null,
        legacyProxy ? h(Field, { label: t('wxid'), hint: t('wxidHint') },
          h('input', {
            type: 'text', value: values.wxid ?? '', spellCheck: false, name: 'wxid',
            ...bindText(set, 'wxid'),
          })) : null,
        !bridgeReceive ? h(Field, { label: t('key'), hint: t('keyHint') },
          h('input', {
            type: 'password', value: keyDraft, autoComplete: 'off', spellCheck: false, name: 'key',
            placeholder: model?.settings?.keyConfigured ? t('keySaved') : '',
            onInput: (event) => setKeyDraft(event.target.value),
            onChange: (event) => setKeyDraft(event.target.value),
          })) : null,
        !bridgeReceive && values.receiveMode === 'webhook' ? h(Field, { label: t('webhookPath'), hint: t('webhookPathHint') },
          h('input', {
            type: 'text', value: values.webhookPath ?? '/wechatpad/callback', spellCheck: false, name: 'webhookPath',
            ...bindText(set, 'webhookPath'),
          })) : null,
        bridgeReceive
          ? h(Field, { label: t('bridgeBaseUrl'), hint: t('bridgeBaseUrlHint') },
            h('input', {
              type: 'text', value: values.bridgeBaseUrl ?? '', spellCheck: false, name: 'bridgeBaseUrl',
              ...bindText(set, 'bridgeBaseUrl'),
            }))
          : null,
        bridgeReceive
          ? h(Field, { label: t('bridgeToken'), hint: t('bridgeTokenHint') },
            h('input', {
              type: 'password', value: bridgeTokenDraft, autoComplete: 'off', spellCheck: false, name: 'bridgeToken',
              placeholder: model?.settings?.bridgeTokenConfigured ? t('keySaved') : '',
              onInput: (event) => setBridgeTokenDraft(event.target.value),
              onChange: (event) => setBridgeTokenDraft(event.target.value),
            }))
          : null,
        bridgeReceive
          ? h(Field, { label: t('bridgeAccounts'), hint: t('bridgeAccountsHint') },
            h('input', {
              type: 'text', value: values.wxid || values.bridgeAccounts || '', spellCheck: false, name: 'bridgeAccounts',
              ...bindText((field, value) => setDraft((previous) => ({ ...previous, [field]: value, wxid: '' })), 'bridgeAccounts'),
            }))
          : null,
        null),
      h('details', { className: 'wxp-advanced' },
        h('summary', null, t('advanced')),
        h('div', { className: 'wxp-grid' },
          !bridgeReceive && !legacyProxy ? h(Field, { label: t('receiveMode') },
          h('select', {
            value: values.receiveMode ?? 'websocket', name: 'receiveMode',
            onChange: (event) => setDraft((previous) => ({ ...previous, receiveMode: event.target.value, apiPrefix: '' })),
          },
          h('option', { value: 'websocket' }, t('receiveWebsocket')),
          h('option', { value: 'webhook' }, t('receiveWebhook')))) : null,
          h(Field, { label: t('requestTimeout') },
            h('input', { type: 'number', min: 5, max: 120, value: values.requestTimeoutSeconds ?? 20, name: 'requestTimeoutSeconds', ...bindText(set, 'requestTimeoutSeconds', Number) })),
          bridgeReceive ? h(Field, { label: t('bridgeClientId'), hint: t('bridgeClientIdHint') },
            h('input', { type: 'text', value: values.bridgeClientId ?? 'dsh', spellCheck: false, name: 'bridgeClientId', ...bindText(set, 'bridgeClientId') })) : null)),
      legacyProxy ? h('p', { className: 'wxp-hint' }, t('legacyProxyHint')) : null);

  const weixinPanel = () => {
    const state = login?.state ?? 'wait';
    const stateLabel = LOGIN_STATE_LABELS[state] ? t(LOGIN_STATE_LABELS[state]) : t('weixinStateUnknown');
    const qrSafe = login?.qrcodeImage || safeQrUrl(login?.qrcodeUrl);
    const needsCode = Boolean(login) && state === 'need_verifycode';
    const retryLogin = TERMINAL_LOGIN_STATES.has(state) || state === 'verify_code_blocked';
    // The status read model is where the Host reports the binding; the
    // settings carry the same fields for a Host that predates status().
    const { botId, boundAt, bound } = readBinding(channelStatus('weixin'), base);
    return h(React.Fragment, null,
      h('div', { className: 'wxp-bot' },
        h('div', { className: 'wxp-cardHead' },
          h('span', { className: 'wxp-cardTitle' }, t('weixinBind')),
          h('span', { className: 'wxp-pill', 'data-phase': bound ? 'connected' : 'idle' },
            h('i', { className: 'wxp-dot' }), bound ? t('weixinBound') : t('weixinUnboundHint'))),
        weixinDirty || !savedProviders.includes('weixin') ? h('p', { className: 'wxp-hint' }, t('saveBeforeLogin')) : h('p', { className: 'wxp-hint' }, t('weixinBindHint')),
        bound
          ? h('div', { className: 'wxp-bot' },
            h('div', { className: 'wxp-row' },
              h('span', { className: 'wxp-hint' }, t('weixinBotId')),
              h('span', { className: 'wxp-mono', 'data-field': 'weixinBotId' }, botId || '—')),
            h('div', { className: 'wxp-row' },
              h('span', { className: 'wxp-hint' }, t('weixinBoundAt')),
              h('span', { className: 'wxp-mono' }, formatStamp(boundAt))),
            null)
          : null,
        login
          ? h('div', { className: 'wxp-grid' },
            h('div', { className: 'wxp-field' },
              h('span', null, t('weixinBind')),
              qrSafe
                ? h('img', { className: 'wxp-qr', src: qrSafe, alt: t('weixinQrAlt'), width: 180, height: 180 })
                : h('div', { className: 'wxp-bot' },
                  h('span', { className: 'wxp-hint' }, t('weixinQrUnavailable')),
                  login.qrcodeUrl
                    ? h('a', { className: 'wxp-mono', href: login.qrcodeUrl, target: '_blank', rel: 'noreferrer noopener' }, login.qrcodeUrl)
                    : null)),
            h('div', { className: 'wxp-bot' },
              h('span', { className: 'wxp-hint', role: 'status', 'data-login-state': state }, stateLabel),
              // The pairing code appears on the phone, so it has to be typed
              // back here before the Host can finish the login.
              needsCode
                ? h('div', { className: 'wxp-bot' },
                  h(Field, { label: t('weixinVerifyCode'), hint: t('weixinVerifyCodeHint') },
                    h('input', {
                      type: 'text', value: verifyCode, name: 'weixinVerifyCode', autoComplete: 'off', spellCheck: false,
                      onInput: (event) => setVerifyCode(event.target.value),
                      onChange: (event) => setVerifyCode(event.target.value),
                    })),
                  h('div', { className: 'wxp-actions' },
                    h('button', {
                      type: 'button', 'data-kind': 'primary', name: 'weixinVerifySubmit',
                      disabled: Boolean(busy) || weixinDirty || !savedProviders.includes('weixin') || !verifyCode.trim(),
                      onClick: () => {
                        const code = verifyCode.trim();
                        if (code) void beginLoginRef.current(code);
                      },
                    }, t('weixinVerifySubmit'))))
                : null,
              login.error ? h('span', { className: 'wxp-error', role: 'alert' }, login.error) : null,
              h('div', { className: 'wxp-actions' },
                retryLogin ? h('button', { type: 'button', 'data-kind': 'primary', disabled: Boolean(busy) || weixinDirty, onClick: () => { void beginLoginRef.current(); } }, '重新生成') : null,
                h('button', { type: 'button', name: 'weixinLoginCancel', onClick: cancelLogin }, t('weixinCancel')))))
          : h('div', { className: 'wxp-actions' },
            h('button', {
              type: 'button', 'data-kind': 'primary', name: 'weixinLoginBegin',
              disabled: Boolean(busy) || weixinDirty || !savedProviders.includes('weixin'),
              onClick: () => { void beginLoginRef.current(); },
            }, busy === 'login' ? t('weixinGenerating') : t('weixinGenerate')),
            bound ? h('button', { type: 'button', name: 'weixinAccountReset', disabled: Boolean(busy) || weixinDirty || !savedProviders.includes('weixin'), onClick: unbind },
              busy === 'unbind' ? t('weixinUnbinding') : t('weixinUnbind')) : null),
        null),
      h('section', { className: 'wxp-card' },
        h('div', { className: 'wxp-cardHead' }, h('span', { className: 'wxp-cardTitle' }, t('weixinAdvanced'))),
        h(Toggle, { label: t('weixinTyping'), checked: values.weixinTyping, onChange: (next) => set('weixinTyping', next) }),
        h(Toggle, { label: t('weixinReplyQuote'), checked: values.weixinReplyQuote, onChange: (next) => set('weixinReplyQuote', next) }),
        h('details', { className: 'wxp-advanced' },
          h('summary', null, t('advanced')),
          h('div', { className: 'wxp-grid' },
            h(Field, { label: t('weixinBotType'), hint: t('weixinBotTypeHint') },
              h('input', {
                type: 'text', value: values.weixinBotType ?? '3', spellCheck: false, name: 'weixinBotType',
                ...bindText(set, 'weixinBotType'),
              })),
            h(Field, { label: t('weixinAccountFile'), hint: t('weixinAccountFileHint') },
              h('input', {
                type: 'text', value: values.weixinAccountFile ?? '', spellCheck: false, name: 'weixinAccountFile',
                ...bindText(set, 'weixinAccountFile'),
              }))))));
  };

  const sessionPanel = () => h('div', { className: 'wxp-tabpanel', role: 'tabpanel', id: 'wxp-panel-session', 'aria-labelledby': 'wxp-tab-session' },
    h('section', { className: 'wxp-card' },
      h('div', { className: 'wxp-cardHead' }, h('span', { className: 'wxp-cardTitle' }, t('session'))),
      h('div', { className: 'wxp-grid' },
        h(Field, { label: t('cwd'), hint: t('cwdHint') },
          h('input', {
            type: 'text', value: values.cwd ?? '', spellCheck: false, name: 'cwd',
            ...bindText(set, 'cwd'),
          })),
        h(Field, { label: t('preset'), hint: t('presetHint') },
          h('input', {
            type: 'text', value: values.agentPreset ?? '', spellCheck: false, name: 'agentPreset',
            ...bindText(set, 'agentPreset'),
          })),
        h(Field, { label: t('replyChunk') },
          h('input', {
            type: 'number', min: 100, max: 4000, value: values.maxReplyChunkLength ?? 1800, name: 'maxReplyChunkLength',
            ...bindText(set, 'maxReplyChunkLength', Number),
          })),
        h(Field, { label: t('mergeDelay'), hint: t('mergeDelayHint') },
          h('input', {
            type: 'number', min: 0, max: 30, step: 0.5, value: values.messageMergeDelaySeconds ?? 0, name: 'messageMergeDelaySeconds',
            ...bindText(set, 'messageMergeDelaySeconds', Number),
          })),
        h(Field, { label: t('incomingMode'), hint: t('incomingModeHint') },
          h('select', {
            value: values.incomingMessageMode ?? 'queue', name: 'incomingMessageMode',
            onChange: (event) => set('incomingMessageMode', event.target.value),
          },
          h('option', { value: 'queue' }, t('incomingQueue')),
          h('option', { value: 'interrupt' }, t('incomingInterrupt'))))),
      h(Toggle, { label: t('showProgress'), checked: values.showProgress, onChange: (next) => set('showProgress', next) }),
      h(Toggle, { label: t('mergeReplies'), checked: values.mergeReplies, onChange: (next) => set('mergeReplies', next) })),
    h('section', { className: 'wxp-card' },
      h('div', { className: 'wxp-cardHead' }, h('span', { className: 'wxp-cardTitle' }, '全局微信通知')),
      h('p', { className: 'wxp-hint' }, '所有会话（包括桌面和网页）的通知统一发送到指定微信。权限仍在 DSH 桌面或网页处理，此通知不接受回复。'),
      h(Field, { label: '从已有微信聊天选择', hint: '选择后会自动填写通知连接和接收聊天 ID；也可在下方手动填写。' },
        h('select', { name: 'notificationChat', value: '', onChange: (event) => {
          if (!event.target.value) return;
          const [provider, chatId] = JSON.parse(event.target.value);
          setDraft((current) => ({ ...current, notificationProvider: provider, notificationChatId: chatId }));
        } },
        h('option', { value: '' }, '选择已有聊天…'),
        ...[...new Map(notificationChats.map((row) => [JSON.stringify([row.provider, row.chatId]), row])).entries()].map(([key, row]) =>
          h('option', { key, value: key }, `${row.provider === 'weixin' ? '扫码机器人' : 'Pad / Bridge'} · ${row.label || row.chatId}`)))),
      h('div', { className: 'wxp-grid' },
        h(Field, { label: '通知连接', hint: '请先在对应连接页启用并保存。' },
          h('select', { name: 'notificationProvider', value: values.notificationProvider ?? 'weixin',
            onChange: (event) => set('notificationProvider', event.target.value) },
          h('option', { value: 'weixin' }, '扫码机器人'),
          h('option', { value: 'pad' }, 'WechatPad / Bridge'))),
        h(Field, { label: '接收聊天 ID', hint: '与微信会话分组中的聊天 ID 一致。留空不发送；扫码机器人须先收到该微信发来的消息。' },
          h('input', { type: 'text', name: 'notificationChatId', value: values.notificationChatId ?? '',
            spellCheck: false, maxLength: 256, ...bindText(set, 'notificationChatId') }))),
      h(Toggle, { label: '任务完成通知', checked: values.notifyTaskCompleted ?? false,
        onChange: (next) => set('notifyTaskCompleted', next) }),
      h(Toggle, { label: '权限请求通知', checked: values.notifyPermissionRequest ?? false,
        onChange: (next) => set('notifyPermissionRequest', next) })));

  const accessPanel = () => h('div', { className: 'wxp-tabpanel', role: 'tabpanel', id: 'wxp-panel-access', 'aria-labelledby': 'wxp-tab-access' },
    h('p', { className: 'wxp-hint' }, '仅用于 WechatPad / Bridge；扫码机器人不使用白名单。'),
    h('section', { className: 'wxp-card' },
      h('div', { className: 'wxp-cardHead' }, h('span', { className: 'wxp-cardTitle' }, t('access'))),
      h('div', { className: 'wxp-grid' },
        h(Field, { label: t('dmPolicy') },
          h('select', {
            value: values.dmPolicy ?? 'allowlist', name: 'dmPolicy',
            onChange: (event) => set('dmPolicy', event.target.value),
          },
          h('option', { value: 'open' }, t('policyOpen')),
          h('option', { value: 'allowlist' }, t('policyAllowlist')),
          h('option', { value: 'disabled' }, t('policyDisabled')))),
        h(Field, { label: t('groupPolicy') },
          h('select', {
            value: values.groupPolicy ?? 'disabled', name: 'groupPolicy',
            onChange: (event) => set('groupPolicy', event.target.value),
          },
          h('option', { value: 'open' }, t('policyOpen')),
          h('option', { value: 'allowlist' }, t('policyAllowlist')),
          h('option', { value: 'disabled' }, t('policyDisabled')))),
        (values.dmPolicy ?? 'allowlist') === 'allowlist' ? h(Field, { label: t('allowedUsers'), hint: t('allowedUsersHint') },
          h('textarea', { value: users, spellCheck: false, name: 'allowedUsers', onInput: (event) => setUsers(event.target.value), onChange: (event) => setUsers(event.target.value) })) : null,
        values.groupPolicy === 'allowlist' ? h(Field, { label: t('allowedGroups'), hint: t('allowedGroupsHint') },
          h('textarea', { value: groups, spellCheck: false, name: 'allowedGroups', onInput: (event) => setGroups(event.target.value), onChange: (event) => setGroups(event.target.value) })) : null,
        h(Field, { label: t('selfWxid') },
          h('input', {
            type: 'text', value: values.selfWxid ?? '', spellCheck: false, name: 'selfWxid',
            ...bindText(set, 'selfWxid'),
          })),
        h(Field, { label: t('commandPrefix') },
          h('input', {
            type: 'text', value: values.commandPrefix ?? '/', name: 'commandPrefix',
            ...bindText(set, 'commandPrefix'),
          }))),
      (values.groupPolicy ?? 'disabled') !== 'disabled' ? h(Toggle, { label: t('groupMention'), checked: values.groupRequireMention, onChange: (next) => set('groupRequireMention', next) }) : null),

    h('section', { className: 'wxp-card' },
      h('div', { className: 'wxp-cardHead' },
        h('span', { className: 'wxp-cardTitle' }, t('seenGroups')),
        h('button', { type: 'button', onClick: () => setGroupsOpen(true) }, t('openGroups'))),
      h('p', { className: 'wxp-hint' }, t('seenGroupsHint')),
      h('p', { className: 'wxp-hint' }, seenGroups.length === 0
        ? t('seenGroupsEmpty')
        : t('seenGroupsSummary', { count: seenGroups.length }))));

  const protocolPanel = (id) => h('div', { className: 'wxp-tabpanel', role: 'tabpanel', id: `wxp-panel-${id}`, 'aria-labelledby': `wxp-tab-${id}` },
    h('section', { className: 'wxp-card' },
      connectionHeader(id, id === 'pad' ? '启用 WechatPad' : '启用微信机器人'),
      id === 'pad' ? providerField() : null,
      id === 'pad' ? padPanel() : weixinPanel()));
  const panels = { pad: () => protocolPanel('pad'), weixin: () => protocolPanel('weixin'), session: sessionPanel, access: accessPanel };

  return h('div', { className: 'wxp', lang: locale === 'en' ? 'en' : 'zh-CN' },
    h('div', { className: 'wxp-header' }, h('h2', null, t('title')), h('span', { className: 'wxp-hint' }, '两种连接可同时启用')),
    disabled ? h('div', { className: 'wxp-banner' }, t('settingsUnavailable')) : null,
    model && model.readable === false && model.reason && model.reason !== 'read-only'
      ? h('div', { className: 'wxp-banner' }, `${t('settingsDiagnostic')}${model.reason}${model.message ? ` — ${model.message}` : ''}`)
      : null,
    h(TabBar, {
      tabs: TABS,
      active: tab,
      t,
      onSelect: (id) => {
        // Navigation never enables, disables or changes a connection.
        setTab(id);
        storeTab(id);

      },
    }),
    // Every panel stays mounted and only one is visible. Mounting them all is
    // what makes each `aria-controls` resolve and keeps the page's DOM stable
    // across switches (an unsaved edit in another tab is never thrown away by
    // navigating); `hidden` is what a screen reader honours as "not shown".
    h('fieldset', { disabled: !model || Boolean(busy) || disabled, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
      TABS.map((id) => React.cloneElement(panels[id](), { key: id, hidden: tab !== id }))),

    groupsOpen
      ? createPortal(h('div', {
          className: 'wxp-backdrop',
          role: 'presentation',
          onClick: (event) => { if (event.target === event.currentTarget) setGroupsOpen(false); },
        },
        h('div', {
          className: 'wxp-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('seenGroups'),
        },
        h('div', { className: 'wxp-cardHead' },
          h('span', { className: 'wxp-cardTitle' }, t('seenGroups')),
          h('button', { type: 'button', onClick: () => setGroupsOpen(false) }, t('close'))),
        h('p', { className: 'wxp-hint' }, t('seenGroupsHint')),
        h('div', { className: 'wxp-table' },
          h('div', { className: 'wxp-tableHead' },
            h('span', null, t('groupColumn')),
            h('span', null, t('groupLastAt')),
            h('span', null, t('groupCount')),
            h('span', null, t('groupAction'))),
          seenGroups.length === 0
            ? h('p', { className: 'wxp-hint' }, t('seenGroupsEmpty'))
            : seenGroups.map((row) => {
              const already = toList(groups).includes(row.chatId);
              return h('div', { className: 'wxp-tableRow', key: row.chatId },
                h('span', null,
                  h('div', { className: 'wxp-mono' }, row.chatId),
                  row.sample ? h('div', { className: 'wxp-hint' }, row.sample) : null),
                h('span', { className: 'wxp-hint' }, formatRelative(row.lastAt)),
                h('span', { className: 'wxp-hint' }, String(row.count ?? '-')),
                h('span', null, h('button', {
                  type: 'button',
                  disabled: already,
                  onClick: () => {
                    const next = [...new Set([...toList(groups), row.chatId])];
                    setGroups(next.join(', '));
                    setNotice(t('addedToGroups'));
                  },
                }, already ? t('alreadyAllowed') : t('addToGroups'))));
            })))), document.body)
      : null,

    h('div', { className: 'wxp-footer' },
      h('div', { className: 'wxp-feedback', 'aria-live': 'polite' },
        h('span', { className: 'wxp-hint' }, !model ? t('loading') : loginTicket.current && dirty ? '完成或取消扫码后再保存' : dirty ? t('unsaved') : t('upToDate')),
        error ? h('div', { className: 'wxp-error', role: 'alert' }, error) : null,
        notice ? h('div', { className: 'wxp-ok', role: 'status' }, notice) : null),
      h('div', { className: 'wxp-actions' },
        dirty ? h('button', { type: 'button', onClick: discard, disabled: Boolean(busy) }, t('discard')) : null,
        h('button', { type: 'button', 'data-kind': 'primary', onClick: save, disabled: !model || disabled || Boolean(busy) || !dirty || Boolean(loginTicket.current) },
          busy === 'save' ? t('saving') : connectionDirty ? t('saveConnect') : t('save')))),
  );
}

/**
 * Register the section with dsh's Settings shell.
 * @param {import('@deepseek-ai/cordis').Context} ctx browser plugin Context.
 */
export function apply(ctx) {
  ctx.effect(() => installConversationGroups(ctx,
    (signal) => callRpc(ctx.connection, 'conversations.list', {}, signal),
    (groupKey, name) => callRpc(ctx.connection, 'conversations.renameGroup', { groupKey, name }),
    () => callRpc(ctx.connection, 'settings.get', {}),
    (patch, expectedRevision) => callRpc(ctx.connection, 'settings.update', { patch, expectedRevision })), 'wechatpad: conversation groups');
  const stopLocale = ctx.locale.register(LOCALE_NAMESPACE, { zh: ZH, en: EN });
  const t = createTranslator(ctx.locale.bind(LOCALE_NAMESPACE));

  const Section = (props) => React.createElement(WechatPadSettings, {
    t,
    connection: ctx.connection,
    locale: ctx.locale.getLocale?.()?.active ?? 'zh',
    close: props?.close,
  });
  Section.displayName = 'WechatPadSettingsSection';

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-wechatpad',
    order: 32,
    label: () => t('微信'),
    locale: LOCALE_NAMESPACE,
  }, Section)), 'wechatpad: settings.section');

  return () => {
    stopLocale?.();
  };
}

export const name = 'dsh-wechatpad-client';
export const inject = ['slots', 'connection', 'locale'];
