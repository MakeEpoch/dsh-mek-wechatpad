# 协议对照：hermes 插件 → dsh 插件

本文件记录两个实现的对应关系，便于从 hermes 版本迁移或对照排查。

## 概念映射

| hermes (`hermes-plugin-wechatpad`) | 本项目 (`@dsh/wechatpad`) |
| --- | --- |
| `plugin.yaml` 声明 `kind: platform` 与一堆环境变量 | dsh 无平台扩展点；本插件是普通 Cordis 插件，Config schema 即设置表单 |
| `gateway`（Hermes 自己的网关进程） | dsh 自身进程；通过 `ctx.typertGateway` 驱动会话 |
| `BasePlatformAdapter` / `MessageEvent` | `session/prompt` + 全局 `session/event` 回复监听；`session/follow` 只读取历史 |
| `settings.dm_policy` 等 PascalCase 环境变量 | Config 字段（camelCase），网页设置面板编辑 |
| `WECHATPAD_KEY`（环境变量，明文） | 直连模式使用只写不读的 `key` 字段；Bridge 代理不传 key，由 Bridge 注入账号密钥 |
| `config.py` + `deps.py` 动态导入 aiohttp/httpx/pilk | 使用 dsh 运行时的 `fetch`、`node:http`、`ws`，二维码依赖 qrcode，SILK 依赖 silk-wasm |
| `transport.py` WebSocket/webhook/bridge 三选一 | `receiveMode`：`websocket`（经 dsh 同源路由）或 `webhook`（dsh 路由 + Pad 回调登记） |
| `inbound.py` 解析 + 媒体下载 | `inbound.js` 解析 + `pad-media.js` 惰性下载 + `media.js` 会话附件 |
| `outbound.py` 分段发送 + 发送节流 | `outbound.js`：按会话队列串行 + 1.1s 秒级间隔 |
| `ref_index.py` 引用/批次/去重索引 | `transport.js` 的 `DedupeWindow`；引用索引未实现 |
| `audio.py` silk 语音 | `voice.js`：SILK 编解码、WAV 归一化、dsh 本地转写 |

## 关键端点

| 用途 | WechatPad 端点 | 本项目调用处 |
| --- | --- | --- |
| 推送 | `GET /ws/GetSyncMsg?key=`（升级为 WS） | `host/transport.js` + `host/ws-route.js` |
| 回调登记 | `POST /message/SetCallback` | `host/pad-api.js` → `setCallback` |
| 发文本 | `POST /message/SendTextMessage` | `host/pad-api.js` → `sendText` |
| 发图片 | `POST /message/SendImageNewMessage` | `host/pad-api.js` → `sendImage` |
| 在线状态 | `GET /login/GetLoginStatus` | 设置页「测试连接」 |
| 轮询兜底 | `POST /message/HttpSyncMsg` | `host/pad-api.js` → `syncMessages` |
| Bridge 代理 | `{base}/proxy/{wxid}/...` | `apiPrefix: '/proxy'` + `wxid` |

## 有意保留的行为

- 同一 `key` 只允许一个连接；dsh 里由插件单实例保证。
- 发送必须秒级间隔：WechatPad 用会话级 `clientMsgId`，同秒会去重。
- 群消息正文前缀 `wxid:\n`，需要拆出发言者。
- 自己发的消息会作为普通消息回到推送里，需要 self-echo 过滤。
- 发送回执中的 `isSendSuccess=false` 或非零 `ret` 表示发送失败，即使外层 `Code=200` 也不能记为成功。

## 本版本未覆盖

- Pad 引用回复的 `msg_source` 回带未实现；视频保留为附件，不自动解析帧。
- 媒体与扫码协议对照另见 [media.md](media.md)。
- 多账号同时接入（hermes 的 `WECHATPAD_ACCOUNTS`）；本插件一次一个 Pad key。

## 会话标题与侧栏归属

参考原项目按真实用户内容命名的语义。dsh 原生自动标题服务需要没有用户手动标题的会话，因此创建时不再用 `session/rename` 设置账号前缀。插件仅提供 `source.kind=fallback` 初始标题，保留原生 provider 自动命名与用户标题保护。原生 Workspace 按 cwd 管理，微信聊天对象使用独立展示分组，避免为归组改变工具的工作目录。
