# WechatPad for dsh

Bridges WeChat into DeepSeek Harness through WechatPad (or WeChat Bridge). Messages become prompts in **real dsh Sessions**, so tools, approvals, history and subagents behave exactly as they do for a typed message; answers come back to the same chat. Everything is configured from the dsh settings page.

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

1. Choose the connection: direct WechatPad needs a Pad address and key, then WebSocket or HTTP callback reception. WeChat Bridge needs its address, subscription token and bot wxid; both directions use the Bridge.
2. Save, then press **Test connection** to check the saved API configuration.
3. Pad / Bridge direct messages default to an allowlist. Add their permitted wxids or select a different policy. The QR bot does not use this allowlist.
4. Save; the plugin reloads with the new configuration and the next WeChat message starts a Session.

Saving writes the profile's Cordis patch through dsh's own Settings service. The key field is declared `role('secret')`, so the page only ever reports that a secret is stored — never its value.

## Independent connections

The WechatPad and iLink bot tabs have separate enable switches, live status, probes and reconnect actions. Both can receive and reply concurrently. Each owns its sessions, inbox and outbound path; session preferences remain shared. Access controls apply to Pad / Bridge only; the QR bot does not use their DM allowlist. Tab navigation never changes configuration. Save applies edits, Discard restores the saved form, and connection actions are blocked while their parameters have unsaved edits.

Legacy profiles retain their existing `provider`. `enabledProviders: [pad, weixin]` enables both, while an explicit empty list disables both. Enable and save the iLink connection before generating a login QR. Credentials stay in a local 0600 file; tokens never cross the settings RPC. Real WeChat login and traffic still require verification with your account.

## Receive modes and endpoints

Only direct WechatPad shows the receive-mode selector. Bridge always subscribes to `/ws/outbound` and sends through `/proxy/{wxid}` without a Pad key. Its client ID is under Advanced (default `dsh`). Existing `receiveMode: bridge` profiles are recognized automatically. Legacy proxy combinations remain marked as legacy until a new connection is explicitly selected and saved.

| Path | Purpose |
| --- | --- |
| `/dsh-wechatpad/ws` | Same-origin upgrade proxying WechatPad's `/ws/GetSyncMsg` push feed |
| `/dsh-wechatpad/callback` | HTTP callback route registered on the Pad via `/message/SetCallback` |

Both live on the dsh web server: the plugin adds no listener, no port and no second credential. Requests pass dsh's Host/Origin fence and browser authentication; the webhook additionally requires a per-process random token.

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

- Both QR/iLink and Pad/Bridge receive images, voice and files, and return generated files through `wechatpad_return_file`. Images include actual model input; originals and documents are staged in the Session workspace. Voice uses local SILK/WAV decoding and the configured dsh speech service.
- QR audio replies are sent as files; Pad/Bridge send native SILK voice up to 60 seconds, then fall back to files. Non-SILK transcoding requires ffmpeg.
- Limits: 16 inbound attachments / 64 MiB combined, 64 MiB per outgoing file; provider/model limits also apply. See [media implementation](docs/media.md).
- Group "was I mentioned" depends on the Pad's `AtWxIDList` or the `@name` markup in the text; Pad builds differ slightly.
- One plugin instance per Pad `key`, matching the Pad's single-account connection.
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
