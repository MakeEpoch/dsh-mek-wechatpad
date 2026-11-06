# WechatPad for dsh

Connects WeChat into DeepSeek Harness through WechatPad (wechatReal08). Messages become prompts in **real dsh Sessions**, so tools, approvals, history and subagents behave exactly as they do for a typed message; answers come back to the same chat. Everything is configured from the dsh settings page.

This is a rewrite of hermes-agent's `hermes-plugin-wechatpad` (a Python platform adapter) against dsh 0.2.1-rc.2's plugin protocol: the Host owns the connection and scheduling, and the browser half contributes its page through the official `settings.section` slot.

## Quick start

```sh
cd .
npm install
npm run build
npm test
npm run install:dsh:web -- --dry-run   # preview
npm run install:dsh:web                # install into the web profile
```

Restart `dsh web`, reload the page, then open **Settings → WeChat**:

1. Enable WechatPad and enter the service URL (port 8062), access token (`ONEBOT_ACCESS_TOKEN` on the server), and one logged-in bot wxid.
2. Save, then press **Test connection** to check the saved API configuration.
3. WechatPad direct messages default to an allowlist. Add their permitted wxids or select a different policy. The QR bot does not use this allowlist.
4. Save; the plugin reloads with the new configuration and the next WeChat message starts a Session.

Saving writes the profile's Cordis patch through dsh's own Settings service. The token field is declared `role('secret')`, so the page only ever reports that a secret is stored — never its value.

## Independent connections

The WechatPad and iLink bot tabs have separate enable switches, live status, probes and reconnect actions. Both can receive and reply concurrently. Each owns its sessions, inbox and outbound path; session preferences remain shared. Access controls apply to WechatPad only; the QR bot does not use their DM allowlist. Tab navigation never changes configuration. Save applies edits, Discard restores the saved form, and connection actions are blocked while their parameters have unsaved edits.

Legacy profiles retain their existing `provider`. `enabledProviders: [pad, weixin]` enables both, while an explicit empty list disables both. Enable and save the iLink connection before generating a login QR. Credentials stay in a local 0600 file; tokens never cross the settings RPC. Real WeChat login and traffic still require verification with your account.

## WechatPad connection

The Pad connection uses OneBot v12: WebSocket events and HTTP actions share `/`, authenticate with a Bearer token, and select the bot through `self`. Server Webhook delivery remains independent. WS is live fan-out without offline replay. See [ONEBOT_V12.md](docs/ONEBOT_V12.md).

When upgrading, retain `baseUrl`, `token`, and `wxid`; remove `clientId`. Cut over the server before installing this plugin. Conversation history, allowlists and iLink credentials stay in place.

## Chat commands

`/new`, `/stop`, `/status`, `/help` (prefix configurable).

## Sidebar groups

WeChat peer groups split only matching sessions from the host's ungrouped bucket. Native workspaces retain their complete session index when peer records load, update or remount. Search, archive filtering, native navigation and per-chat group settings stay available.

## How it talks to dsh

The Host calls `ctx.typertGateway.invoke/stream` with a Peer created by `ctx.connection.createPeer({ principal: { kind: 'owner' } })`. No extra HTTP hop or token is involved: the same process answers, and a WeChat message carries the same authority as one typed in the UI.

- inbound message → policy → find or create that chat's Session → `session/prompt` (queued);
- `session/follow` supplies the durable event stream; only `assistant/message` text parts are forwarded (reasoning never leaves the Host);
- a Session deleted in the dsh UI makes the next message start a fresh one.

## Known limits

- Both QR/iLink and WechatPad receive images, voice and files, and return generated files through `wechatpad_return_file`. Images include actual model input; originals and documents are staged in the Session workspace. Voice uses local SILK/WAV decoding and the configured dsh speech service.
- QR audio replies are sent as files; WechatPad send native SILK voice up to 60 seconds, then fall back to files. Non-SILK transcoding requires ffmpeg.
- Limits: 16 inbound attachments / 64 MiB combined, 64 MiB per outgoing file; provider/model limits also apply. See [media implementation](docs/media.md).
- Group "was I mentioned" depends on the Pad's `AtWxIDList` or the `@name` markup in the text; Pad builds differ slightly.
- One WechatPad connection subscribes to one bot wxid.
- Browser activation and real WeChat traffic must be verified in your own environment; the tests cover unit logic, the Host API and the rendered settings page.

## Layout

```
host/                 Cordis plugin (entry, config, runtime, Pad client, transport, routes, RPC, settings)
client/index.js       Browser settings page (settings.section)
lib/client.js         Built ModuleLoader bundle
scripts/              build / install
tests/                unit, host integration, settings-page render
```

MIT licensed.

## Bot links (0.1.9)

The right-side settings of a Main Bot or Bot group bind a WechatPad group to a Bot group, or a WeChat private chat to a Main Bot only. Requires the optional `mekBotBridge` v1 service (downstream Bot 0.2.9). Identity and chat-type restrictions are validated server-side on every use. Existing access and mention policies still apply. Unlinked chats retain their ordinary Sessions; removed or demoted targets fail without creating a fallback Session.

Visible text replies are mirrored; hidden Bot turns, reasoning and user echoes are excluded. Linked private messages honor queue/interrupt settings; group messages queue; `/stop` targets the linked conversation. Approval, credentials and interactive cards remain in DSH. WeChat-originated Main Bot turns can return audio, images and files through `wechatpad_return_file` or host `present`; immutable snapshots go only to the originating connection/chat after a successful turn. Group files require explicit attachment links in visible posts. Web or mixed-origin turns cannot borrow this permission, and cancellation/unlink revokes delivery. Registration is queued, not delivered. Historical replay, cross-end card answers and the upstream eight-platform IM module remain outside scope. Links are atomically stored with a revision in `wechatpad/bot-links.json` and saved independently from connection settings.

Choose either WechatPad or WeChat robot (iLink) and select a discovered user; send the connection a private message first, then refresh. Groups are selected from the Bot group settings and support WechatPad only. Known chat IDs and names are stored without message bodies or reply context tokens. The global WeChat Sessions settings now show a summary. The optional `wechatBotLinks` v1 service distinguishes missing/incompatible plugins, startup, disabled/unconfigured/signed-out connections, reconnecting, failures and readiness. Existing links survive disconnection; creating links requires a ready connection.

Version 0.1.10 connects iLink typing signals to ordinary delivery turns and linked Main Bot activity, refreshes active signals and clears them on idle, cancellation, unlink or disposal. Per-chat leases serialize concurrent turns. The Pad protocol has no typing support. Linked private interruption now follows per-chat configuration and preserves the existing DSH pending queue; native Bot views show that real queue. Signal tests do not establish actual WeChat client display.


### iLink attachment network handling

Upload URL negotiation retries transient network/timeouts and HTTP 502/503/504 up to three attempts with the same file metadata. Permanent failures are not retried. Errors identify negotiation, CDN upload, or final message sending with sanitized transport codes. CDN uploads and final sends are not automatically replayed; an uncertain final receipt requires checking WeChat before resending. See the media implementation notes for validation limits.
