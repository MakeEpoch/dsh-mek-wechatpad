# WeChat OneBot v12 接入约定

公开协议统一为 OneBot v12 JSON：HTTP POST `/` 执行动作，WebSocket `/` 接收事件及执行动作，Webhook 向配置的单一 URL POST 事件。HTTP/WS 使用 `Authorization: Bearer <access_token>`；Webhook 使用同一 Token。WS 不再携带 client_id 或 wxids，消费方按 `self.platform` / `self.user_id` 过滤账号。旧 `/bridge/*`、`/proxy/*`、`/ws/outbound` 不再注册。

动作请求示例：

```json
{"action":"get_self_info","params":{},"self":{"platform":"wechat","user_id":"bot-example"},"echo":"request-example"}
```

响应示例：

```json
{"status":"ok","retcode":0,"data":{"user_id":"bot-example","user_name":"Bot","user_displayname":""},"message":"","echo":"request-example","wechat.source":{"provider":"wechatreal08","data":null}}
```

`data` 与标准事件字段始终优先。`wechat.source` 是可选扩展，包含 provider 和筛选后的原始业务数据；不包含完整会话对象或结构化凭据字段。正常文本、群提及、文件收发均不依赖 source。不要再让消费方根据 provider 名称选择 HTTP 接口。

## 标准能力与限制

- `get_version`、`get_supported_actions`、`get_status`；标准用户、好友、群、群成员查询。
- `send_message`：private/group，text/mention/image/voice/file；上传/下载使用 `upload_file` / `get_file`，file_id 对机器人账号隔离。
- 文件上限 32 MiB，缓存保存 7 天；业务归档应转存对象存储。upload 支持 data/url，get 支持 data；path、分片上传、视频发送、撤回和 HTTP 事件轮询暂不支持，明确返回非零 retcode。
- 语音发送使用 SILK，`voice.data["wechat.duration"]` 为 1..60 秒。底层拒绝发送会返回失败，不会伪装成功。
- 事件类型 private/group；文本提及采用 mention 段；图片、语音、视频、文件提供 file_id。微信卡片、系统消息等暂用 `wechat.native` 段，原始业务内容在 source。
- 自发消息以 `wechat.is_self` 和 `wechat.target_id` 明确方向和目标；普通接收消息不依赖这两个扩展。
- WS 首帧 connect，然后 status_update，30 秒 heartbeat；登录状态变化发布 status_update。当前支持正向 WS，尚未实现反向 WS。
- Webhook 仅将 200/204 作为确认；失败保留队列重试。200 可返回动作数组，204 无动作。事件 id 用于消费方去重；echo 仅关联请求响应，不是发送幂等键，发送超时不得无条件重试。

## 微信专有扩展

登录生命周期使用 `wechat.account.create/bind/list/get_qr/check_login/status/logout/delete`，账号记录标识为 `account_id`，与访问 Token 区分。

过渡期显式能力包括 `wechat.get_contacts_page`、`wechat.get_contact_details`、`wechat.get_group_details`、`wechat.get_group_members`、`wechat.get_enterprise_contact`、`wechat.get_profile`、`wechat.get_login_status`，以及旧历史媒体归档需要的 download/upload/send_app_message/send_emoji 动作。能力列表以 `get_supported_actions` 为准。原生参数只出现在这些扩展里，普通收发使用标准动作。

替换底层服务时实现 `bridgeapi.Provider`；微信标准能力、上述实际使用的扩展由服务端转换。后台历史富消息处理仍会消费 source / 扩展，是后续继续标准化的明确边界，不能宣称完全零成本替换所有微信特性。

## 配置与切换

服务端：`onebotenabled=true`，环境变量 `ONEBOT_ACCESS_TOKEN`，`onebotwebhook=http://backend:8000/open/wechat/webhook`。

后台：`ONEBOT_HOST`、`ONEBOT_PORT`、`ONEBOT_ACCESS_TOKEN`。管理端 API 使用 accountId、gatewayUrl、protocol；数据库原有 auth_key/api_base/bridge_host 列暂不改名，账号记录、wxid、会话和消息无需搬迁。

DSH：保留 baseUrl、token、wxid、白名单和会话配置，删除 clientId；token 保留原有环境变量引用。只有一套 OneBot 接入，不保留旧 Bridge 模式。

切换前备份二进制、配置和 SQLite，排空旧 Webhook outbox，再停止旧网关；确认待投递为零后成组切换网关、后台、管理端、插件。原 bridge.db 文件名和表名仅是内部存储，不删除、不重建。新增 onebot_files 缓存表自动创建。未排空的旧事件必须先完成旧投递或显式离线迁移，禁止把旧事件直接发到新 Webhook。

参考：[OneBot v12 规范](https://12.onebot.dev/)。这是本实现的能力子集，具体支持情况以发现接口及本文为准。
