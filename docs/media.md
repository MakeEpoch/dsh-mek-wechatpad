# 媒体实现与验收

## 参考实现

- Pad / Bridge：本机原项目 `hermes-plugin-wechatpad/wechatpad/inbound.py`、`outbound.py`、`audio.py`，以及 WechatPad Swagger。沿用 GetMsgBigImg 分块、GetMsgVoice、SendImageNewMessage 和 SendVoice 形状；文件按当前部署 Swagger 与本地 wehub_util.py 的 UploadAppAttach → SendAppMessage 流程发送；Bridge 使用原有 `/proxy/{wxid}` 代理，不发送直连 key。
- 扫码：安装的 `@xmanrui/dsh-im@5.1.0` 的 `src/channels/weixin/weixin-api.mjs`、`weixin-bridge.mjs`。沿用 iLink AES-128-ECB CDN 上传下载及图片／文件消息。
- 文件回传：改编 dsh-im `src/channels/shared/semantic/artifact.mjs` 的工具快照和按请求／轮次归属的投递登记，保留 [MIT 许可](../host/vendor/DSH-IM-LICENSE)。使用插件专属工具名和登记表，避免与原 IM 插件串用。
- SILK：[silk-wasm 官方实现](https://github.com/idranme/silk-wasm)，运行时依赖固定在 lockfile。识别 WAV 使用 16 kHz、单声道、16 位；发送 SILK 使用 24 kHz。

## 生命周期

1. 两个连接独立解码为文本及惰性附件描述。
2. 通过访问控制后，在会话工作区下载附件；扫码不使用 Pad 白名单。
3. 图片检测格式并作为真实 image content 入队，语音解码及转写，文件生成可供工具读取的路径；保留原始附件。
4. 微信轮次向模型注入附件交付指导，支持 `wechatpad_return_file` 和原生 `present`。二者都会登记不可变快照，仅成功工具结果提交到当前微信请求所属轮次；Code Mode 子调用还须父工具成功。`present` 的快照在执行阶段准备，避免异步结果观察者与 turn/end 竞态。
5. turn/end 先交付文本，再按原连接／聊天发送快照。失败明确提示；取消与销毁释放未发送快照，并中止上传下载。

工具与模型指导在 Agent 创建／领取消息时注册到该 Agent 的工具服务，不能假设宿主根作用域有 tools、systemPrompt。指导标记 required，仅微信所属轮次产生内容。回复中的本地 Markdown 图片／文件链接、Hermes `<wximg>`／`<wxfile>`／`<wxvoice>`／`<wxvideo>` 和 `MEDIA:` 同样会提取成快照附件；相对路径按会话工作目录解析。正文普通路径、代码示例及远程链接不触发自动发送；同名同内容附件在单轮去重。

## 边界

- 原 iLink 实现没有原生语音发送接口，扫码回传音频走文件消息，不假设未知协议字段。
- Pad 文件使用 `/other/UploadAppAttach` 的 fileData 获取 mediaId，再以 ContentType=6 的 AppList 调用 `/message/SendAppMessage`；不调用旧 SendFileMessage。两步都不自动重试；上传失败或缺少 mediaId 时不发送消息，内层 retCode 拒绝会明确报错。
- 视频按附件下载并保留，回传走文件通道；不会自动理解视频帧。
- 语音识别是 dsh 可选服务；缺少服务／模型未准备时保留 WAV 并报告无法转写。当前内置识别服务有自己的时长和大小限制。
- 下载只允许提供方 CDN，不跟随未知跳转；附件单条总量 64 MiB / 16 个，回传单文件 64 MiB。文件权限 0600，目录 0700。
- 对模型明确的图片入队拒绝会以同一 requestId 回退为文件路径，不重复提交已接受的任务。

## 验证

`tests/media.test.mjs` 覆盖 CDN 解密、原图分块、语音真实 SILK 编解码、识别服务接线、附件合并、图片独立消息、按聊天回复凭证、Pad/Bridge HTTP 报文、iLink 加密上传、文件快照和图片入队回退。

`tests/scheduled-delivery.test.mjs` 另外覆盖两路原生 `present` 的多图片／文件交付、不可变快照、失败调用／父工具不发送，以及网页轮次不向微信转发。

这些测试使用模拟协议服务，不能代替用户微信端的实际收图／收语音／收文件验收。真实验收应分别从扫码和 Pad 账号发送图片、语音、小文件，并要求 dsh 将原件或生成文件回传。
