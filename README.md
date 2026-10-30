# WechatPad · 微信接入 dsh

把微信接到 DeepSeek Harness：微信消息进入**真实 dsh 会话**（工具、审批、历史、子代理都与在网页里敲字完全一致），回复回到同一个聊天。配置全部在 dsh 设置面板里完成。

参考实现是 hermes-agent 的 `hermes-plugin-wechatpad`（Python 平台适配器），本项目按 dsh 0.2.1-rc.2 的正式插件协议重写：Host 负责连接与调度，Client 通过官方 `settings.section` 槽位提供设置页。

| 能力 | 说明 |
| --- | --- |
| 收发 | 扫码机器人与 Pad / Bridge 可同时在线；支持文本、图片、语音和文件 |
| 附件 | 图片以实际图像输入模型；语音转 WAV 并调用 dsh 转写；文件保存到会话工作区供工具读取 |
| 回传文件 | dsh 使用 `wechatpad_return_file` 将生成的图片、音频或文件发回原聊天 |
| 会话 | 运行期间每个聊天自动延续上下文，重连、重启后继续原对话；`/new`、`/reset` 或原对话被删除后才新建 |
| 访问控制 | 私聊/群聊独立策略：全部响应 / 仅白名单 / 忽略；群聊默认需 @ |
| 回复 | 长答案按段落/句子分段发送，自动去掉 Markdown 与推理标签 |
| 进度 | 运行中把工具调用作为状态行发回微信（可关闭） |
| 提问 | `ask_user_question` 的题目、选项和说明发回微信；回复编号或文字继续任务，支持多题、多选和网页端回答 |
| 消息处理 | 可设置合并等待秒数；新消息可选择排队，或停止当前任务后提交 |
| 设置 | 「设置 → 微信」实时状态、连接测试、全部配置项 |
| 通知 | 所有会话的任务完成、权限请求可单向提醒到指定微信，两个开关独立配置 |

## 快速开始

```sh
cd .
npm ci                 # 安装 WebSocket、二维码、SILK 依赖和构建工具
npm run build          # 生成 lib/client.js
npm test               # 单元 + Host 集成测试
npm run test:package    # 独立目录验证安装包和运行依赖
npm run install:dsh:web # 打包安装进 web profile（先 --dry-run 预览）
```

安装使用 DSH profile 中保存的安装包，运行代码和依赖不链接源码目录。修改源码后需重新构建、安装。

然后重启 `dsh web` 并刷新页面，打开 **设置 → 微信**：

1. 在 **WechatPad** 页启用连接，选择 **Pad 接入方式**：直连 WechatPad 时填 Pad 地址和 Key，并选择 WebSocket 推送或 HTTP 回调；WeChat Bridge 时填 Bridge 地址、Token 和机器人 wxid，收发均经 Bridge。
2. 需要扫码机器人时，在 **微信机器人** 页独立启用，保存后生成二维码并用微信确认。两种连接可同时在线，配置不会互相覆盖。
3. 保存后点各连接的 **检测连接**；重新连接只作用于当前连接。
4. WechatPad / Bridge 的私聊默认 `仅白名单`，把允许的 wxid 填进 **私聊白名单**。扫码机器人不应用此白名单。
5. 保存后立即应用配置并更新受影响的连接，给机器人发一条微信即可开始。

> 保存会写入当前 profile 的 Cordis patch，并由 dsh 的 Settings 服务校验和持久化；密钥字段以 `role('secret')` 声明，设置页只显示「已保存」，永远不会回读密钥本身。

## 两种独立连接

**WechatPad**（直连 Pad 或 Bridge）和 **微信机器人**（腾讯 iLink 扫码）可同时启用。两路分别维护连接状态、消息计数、会话、消息队列和回复通道；同名聊天不会串用会话。会话偏好共用「会话」设置；「访问控制」仅作用于 WechatPad / Bridge，扫码机器人不应用私聊白名单。仅在接入方式下拉框中切换 Pad 与 Bridge。

页面切换不会改变连接或触发保存。修改后可「保存并连接」或「放弃更改」；保存完成会回读配置，未保存连接参数时不能检测或重连旧配置。高级项默认收起，白名单仅在选择对应策略时显示。

iLink 的扫码凭据存于本地 `wechatpad/weixin-accounts/credentials.json`（文件权限 0600），二维码在本地生成。未绑定时不会发起消息轮询；解除绑定只清空该机器人的凭据。设置页只显示脱敏账号，不返回 token。两种连接均支持附件收发，协议差异见下表。

旧 profile 未声明 `enabledProviders` 时沿用原 `provider`，不会自动开启第二条连接；显式 `[]` 关闭两路。

> 当前源码的自动测试中，Pad / Bridge 发送语音返回值的两项断言未通过；相关发送结果需要进一步验证，不能仅凭这些测试确认送达。

## 图片、语音和文件

| 消息 | 扫码机器人 | Pad / Bridge |
| --- | --- | --- |
| 接收图片 | 下载并解密 iLink CDN 原图 | 优先按 msg_id 分块下载原图，兼容内嵌数据和 CDN |
| 接收语音 | 解密 SILK，转 WAV；优先使用微信附带转写，否则交给 dsh 转写 | GetMsgVoice / 内嵌音频，转 WAV 后交给 dsh 转写 |
| 接收文件 | 下载并解密 CDN 文件 | 内嵌文件 / 带 AES key 的 CDN 下载 |
| dsh 发图片 | 加密上传 CDN，发送图片消息 | SendImageNewMessage 原生图片 |
| dsh 发音频 | 音频文件（沿用原 iLink 实现的文件通道） | 转 SILK，60 秒以内发原生语音；更长音频发文件 |
| dsh 发文件 | 加密上传 CDN，发送文件消息 | UploadAppAttach 上传后用 SendAppMessage 发送，Bridge 自动走账号代理 |

收到的附件保存在该会话工作区的 `.dsh-wechatpad/inbound/`，每条消息独立目录，文件名会清理路径分隔符。图片同时作为真实 image content 送入模型；文件路径及类型进入本条提示，供 dsh 文件工具处理。不会将下载凭证或 AES key 放入模型提示。文件内容属于用户输入，不作为系统指令。

让 dsh 发附件时，可以直接说「把刚才生成的报告发给我」或「把这张图发回来」。插件只在该微信任务中提供 `wechatpad_return_file({path})`，支持工作区相对路径和绝对路径。工具登记不可变文件快照，成功完成本轮后发到原连接的原聊天；发送失败会在微信中明确提示。`/stop`、`/new` 和断开连接会取消待处理的下载、发送和登记。普通网页会话不会获得微信投递权限。

语音使用 dsh 的 `speechToText` 服务。首次使用时在 dsh 的「插件 → 语音输入」启用并准备本地 SenseVoice 模型；SILK 编解码由 `silk-wasm` 完成，其他音频转码需要本机 `ffmpeg`。未配置识别服务或转写失败时保留 WAV，并明确提示模型没有得到语音内容，不会伪造转写。

单条消息最多 16 个附件，总量最多 64 MiB；单个回传文件最多 64 MiB，实际还受微信端限制。超过模型图片限制或模型不支持图片时，保留原图并提示使用文件工具；不会把占位符当成已看过图片。附件留在会话工作区供后续引用，需要时可自行清理。

### 全局微信通知

在「设置 → 微信 → 会话 → 全局微信通知」中，从已有微信聊天选择接收人，或手动填写通知连接与聊天 ID，然后分别开启「任务完成通知」「权限请求通知」并保存。默认关闭，接收聊天 ID 留空时不发送；所选连接须已启用，扫码机器人须先收到接收人发来的微信消息以取得回复凭证。

通知覆盖所有会话，包括桌面和网页发起的任务。正常完成一轮时发送完成提醒；取消、报错、中断不报成完成。权限请求仅发送工具名、原因和会话信息，仍在 DSH 桌面或网页处理，不支持通过此通知回复或授权。通知不转发完整任务结果，也不重播启动前的历史事件。原有微信会话回复及审批功能保持独立。发送失败记入插件日志，不阻塞任务或审批，不自动补发。

英文权限原因会使用该会话最近一次实际请求的模型翻译成中文，保留原文供核对，中文说明已有时直接使用。翻译只发送权限原因，不发送会话全文；工具命令和参数原文保持独立。翻译最多等待 8 秒，模型不可用或输出无效时保留原文，原界面审批不等待翻译。原有微信审批卡片也使用同一份翻译。

### 定时任务投递

通过微信会话创建的宿主定时任务会自动发回原微信对象，Pad / Bridge 与扫码机器人均支持文本和文件。出站监听随连接常驻，不依赖先收到微信消息，也没有 20 分钟空闲或运行超时的限制。每轮结束只释放本轮状态和文件权限；重启不重播历史答案。

只有插件提交的微信输入与可信 `source.kind=schedule` 的定时输入可开启投递；网页直接操作同一会话不会自动转发。`/new` 不会删除旧会话的定时任务，旧任务仍发给创建时的微信对象，需要停止时请暂停或删除任务。

iLink 的回复凭证、去重信息及接收游标保存在账号目录下 `state/`，目录 0700、文件 0600；重新扫码更换凭证或重置账号会清除旧状态。旧版未保存回复凭证时，需要先给扫码机器人发送一条消息；以后重启可恢复。上游拒绝凭证或发送失败会明确记录，不将宿主任务完成当作微信已送达。

### 侧栏分组与标题

微信会话按聊天对象显示为可折叠分组：Pad / Bridge 显示账号或聊天 ID，扫码用户显示短 ID；两种接入的同名对象分别分组。点击分组旁的“…”或右键分组名打开原生操作菜单，选择“重命名”即可编辑，Enter 保存、Esc 取消，名称限 1–40 个字符；名称保存在 Host，刷新、重启和该聊天的新会话都会沿用。分组只改变侧栏展示，不改变会话工作目录。插件只从宿主未分组列表中拆出微信会话；普通工作区及其会话索引完整保留，微信分组异步加载、刷新和重挂载不会清空工作区内容。原生搜索、置顶、归档和重命名继续可用；当前筛选下没有会话的微信分组不显示。分组内按 Host 的会话顺序展示，不支持拖动改序。

新会话先用消息正文、语音转写或附件名称生成简短标题，再交给 dsh 自带的标题服务按内容命名。手动修改过的标题会保留。分组归属保存在 `wechatpad/conversations.json`，可从插件创建会话的日志恢复历史归属；索引同时保存每个接入方式、聊天对象的当前对话；重启后继续同一个 dsh 会话。


实现及参考来源、协议限制见 [媒体实现说明](docs/media.md)。

## Pad 接入方式

| 方式 | 何时用 | 配置 |
| --- | --- | --- |
| 直连 WechatPad | Pad 与本机/内网直通 | WechatPad 地址、Key；接收方式选择 WebSocket 推送或 HTTP 回调 |
| WeChat Bridge | 由 Bridge 管理账号，或需要与其他消费者并行 | Bridge 地址、Bridge Token、机器人 wxid；固定订阅 `/ws/outbound`，发送自动走 Bridge 代理，无需 Pad Key |

Bridge 的客户端标识在「高级」中设置，默认 `dsh`；同一 Bridge 的消费者应使用不同标识。现有 `receiveMode: bridge` 配置会直接显示为 WeChat Bridge，无需迁移。旧版 `apiPrefix` 代理组合会标注为旧版配置，选择新的接入方式并保存后才切换路径。

仅直连 WechatPad 时显示接收方式：

- **WebSocket 推送**：插件经 dsh 自己的 `/dsh-wechatpad/ws` 路由连到 Pad 的 `/ws/GetSyncMsg`。浏览器与 dsh 之间只走同源连接，`key` 不会进前端。
- **HTTP 回调**：插件在 dsh 上注册 `/dsh-wechatpad/callback`，并调用 Pad 的 `/message/SetCallback` 自动登记；回调带每进程随机 token 与 dsh 的 Host/Origin 校验。

直连时要能访问 Pad 服务；HTTP 回调还要求 Pad 能访问 dsh Web 地址，可在连接设置中修改回调路径。插件不监听任何额外端口。

## 微信里可用的命令

| 命令 | 作用 |
| --- | --- |
| `/new`、`/reset` | 保存重置状态，下一条消息开新会话；重启不会恢复旧上下文 |
| `/stop` | 请求停止当前运行 |
| `/status` | 通道状态、当前会话、收发统计 |
| `/help` | 命令列表 |

前缀可在设置里改（默认 `/`）。

遇到提问时，回复 `1`、`2` 等选项编号，或直接回复文字；多选可回复 `1,3`，多道题会依次展示。`/skip` 跳过提问，纯数字的自定义回答用 `文字: 123`。群内只有原提问者能回答，回答时无需再次 @。同时有多条提问时，按题目下方的 `/answer 标识 答案` 格式回复。网页和微信先回答的一端生效。

## 配置项

设置页与「设置 → 插件 → 可配置插件」里的表单等价，字段来源是本插件的 Config schema：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabledProviders` | 沿用旧 `provider` | 可选 `pad`、`weixin`，可同时启用；空列表关闭两路 |
| `enabled` | 开 | 关闭后运行时断开微信，保留全部配置 |
| `baseUrl` | `http://127.0.0.1:8059` | 直连 WechatPad 地址 |
| `key` | 空 | 直连 Pad key（密钥，不回显） |
| `apiPrefix` / `wxid` | 空 | 兼容旧版代理配置；新配置无需填写 |
| `receiveMode` | `websocket` | `websocket` / `webhook` 为直连；`bridge` 为 Bridge 接入，收发均经过 Bridge |
| `bridgeBaseUrl` / `bridgeToken` | 空 | Bridge 地址和订阅 Token（密钥，不回显） |
| `bridgeAccounts` | 空 | 机器人 wxid；旧配置留空时兼容使用 `wxid` |
| `bridgeClientId` | `dsh` | Bridge 客户端标识，设置页位于高级项 |
| `cwd` | 空 | 新会话的通用工作目录；空时按聊天创建 `~/.dsh/wechat/<chatId>`，扫码聊天在 `~/.dsh/wechat/weixin/` 下 |
| `agentPreset` | 空 | 新会话 Agent Preset |
| `sessionTitlePrefix` | `微信` | 兼容旧配置；标题现按内容自动生成，此项不再使用 |
| `maxReplyChunkLength` | 1800 | 单条回复最大字数 |
| `showProgress` | 开 | 发送工具调用状态行 |
| `mergeReplies` | 关 | 等一轮回复完成后把多段文本合并发送；超过单条字数限制仍分段 |
| `chatOverrides` | 空 | 在工作区的微信聊天分组「… → 设置」中，按 chat 覆盖工作目录、回复合并、分段长度、进度、入站合并等待和新消息处理方式；清除覆盖即跟随通用设置 |
| `messageMergeDelaySeconds` | 0 | 同一聊天同一发送者的消息在停止输入后等待 0–30 秒，按顺序合并；0 为立即处理 |
| `incomingMessageMode` | `queue` | `queue` 等当前任务完成；`interrupt` 停止当前任务后提交新消息，保留已排队消息 |
| `dmPolicy` / `groupPolicy` | `allowlist` / `disabled` | 全部响应 / 仅白名单 / 忽略 |
| `allowedUsers` / `allowedGroups` | 空 | 白名单，可用逗号分隔 |
| `groupRequireMention` | 开 | 群聊需 @ 才响应 |
| `selfWxid` | 空 | 机器人 wxid，用于忽略自己的回声 |
| `commandPrefix` | `/` | 控制命令前缀 |

## 结构

```
wechatpad/
  host/                 # Host 侧：Cordis 插件
    index.js            # 入口：Config、effect、面板 facade
    config.js           # Config schema（volatile / secret）与归一化
    wechatpad-service.js# 运行期：传输、持久会话路由、状态
    pad-api.js          # WechatPad HTTP 客户端与信封解析
    inbound.js          # 消息解码、策略、分段、文本清洗
    outbound.js         # 按会话串行发送
    transport.js        # 推送连接、去重窗口、帧解析
    harness.js          # 通过 typertGateway 驱动 dsh 会话
    questions.js        # 提问展示、回答解析、网页/微信竞速与取消
    ws-route.js         # /dsh-wechatpad/ws 与 /callback 路由
    management-rpc.js   # 设置页的 RPC 通道
    settings-bridge.js  # 读写 dsh Settings 服务
  client/index.js       # 浏览器侧：settings.section 页面
  lib/client.js         # 构建产物（ModuleLoader bundle）
  tests/                # 单元、Host 集成、设置页渲染
```

## 工作原理

Host 与 dsh 之间不另开 HTTP 端口、不另发 token：调用直接走 `ctx.typertGateway.invoke/stream`，用一个 `ctx.connection.createPeer({ principal: { kind: 'owner' } })` 创建的 Peer 身份，因此微信里发生的一切与你在网页里操作拥有相同的权限模型。

- 收到消息 → 策略过滤 → 找到/创建该聊天的会话 → `session/prompt` 入队；
- 普通消息按聊天和发送者合并，按聊天串行提交，避免首次连发创建多个会话；提问答案与控制命令即时处理，`/stop`、`/new` 清理待合并消息；
- 当前聊天到 dsh 会话的对应关系保存在 `wechatpad/conversations.json`；普通重连和服务重启都继续原对话。升级时从插件已有记录选用每个聊天最近创建的对话，保留旧对话历史；
- 排队保留原回复监听；打断使用 `session/cancel` 后提交合并的新消息，不丢弃宿主中已有的队列。设置中的合并时长、处理模式和运行进度开关读取实时配置，保存后生效；
- 群里只 @ 其他人时不触发回复；已允许群的近期文字暂存两小时、每群最多 20 条，在下一次 @ 机器人时作为背景带入并在提交成功后清除；
- 全局监听 `session/event`，把 `assistant/message` 的文本部分回发微信（推理片段永远不外发）；
- `user-questions/request` 根据当前轮次的原始微信请求定位聊天和发送者，将选项发回微信，回答回传给正在等待的工具；
- 会话在 dsh UI 里被删除后，下一条消息自动新建会话。

## 已知边界

- 扫码音频回传使用文件消息；Pad / Bridge 原生语音受 60 秒限制。识别和图像理解能力取决于 dsh 的语音服务与模型。
- 群聊里「被 @」依赖 Pad 推送里的 `AtWxIDList` 或文本中的 `@xxx` 标记；不同 Pad 版本字段略有差异。
- 一个 dsh 进程同时只能有一个插件实例在用同一把 `key`（与 Pad 的单账号连接一致）。
- 浏览器激活、真实微信收发需要在你自己的环境里验收；本仓库的测试覆盖单元逻辑、Host 接口与设置页渲染，不包含真实微信。
- `maxReplyChunkLength` 较小、答案很长时会分成多条消息发送；WeChat 在同一秒内会去重，插件已按秒级间隔串行发送。

## 卸载

```sh
dsh plugin --profile web remove dsh-mek-wechatpad --ignore-scripts
```

然后重启 `dsh web`。原始 profile 文件备份在 `~/.dsh/profiles/web/.plugin-manager/wechatpad-backup-*`。

## 许可

MIT。

## DSH 宿主依赖

DSH、Cordis、Schemastery 等宿主 API 由 DSH 运行时提供，声明为 peer 依赖。开发时通过 `npm ci` 安装独立的开发依赖；生产插件不携带宿主核心库副本，否则会破坏智能体作用域，导致工具重复注册。
