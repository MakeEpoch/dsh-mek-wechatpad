# 安装到 dsh Web

插件目录：`.`。父目录 `dsh/` 用于放多个独立插件。

本插件按本机 dsh **0.2.1-rc.2** 的正式插件协议实现：Cordis Host 入口、bundle patch、`dsh.client` 清单与已构建的 `lib/client.js`，不修改 dsh 官方源码。

## 1. 构建

```sh
cd .
npm ci               # 安装运行依赖和构建工具
npm run build        # 生成 lib/client.js
npm test
npm run test:package # 在独立目录验证安装包与运行依赖
```

只需要随包产物时，安装到 dsh 不必执行 `npm install`。若本机无法联网安装 esbuild，可复用已有安装：

```sh
DSH_ESBUILD_MODULE=/path/to/node_modules/esbuild npm run build
```

## 2. 安装

```sh
node scripts/install-web.mjs --dry-run   # 先看计划
npm run install:dsh:web
```

安装器要求 `~/.dsh/profiles/web`（或 `$DSH_HOME/profiles/web`）已经存在，并确认它是 Web profile；随后备份清单、锁文件与 patch。

安装器先执行 `npm pack --ignore-scripts`，将带 SHA-256 标识的安装包保存到目标 profile 的 `.plugin-manager/packages/`，再调用：

```sh
dsh plugin --profile web add -w file:/path/to/profile/.plugin-manager/packages/wechatpad-<version>-<sha256>.tgz --ignore-scripts
```

Host、Client 和 `ws`、`qrcode`、`silk-wasm` 运行依赖安装在 DSH profile 中，不链接源码目录。安装后独立检查 bundle 选择、安装路径和依赖解析路径；回执保存在 `artifacts/dsh-install.json`。源码修改后需重新构建和安装才会生效。重复安装同一内容会验证现有安装；默认允许下载依赖，仅在本地缓存完整时使用 `--offline`。

`DSH_PROFILE` / `DSH_HOME` / `DSH_BIN` 可覆盖默认的 profile、dsh 主目录与命令。

## 3. 激活

重启运行 `dsh web` 的进程，然后刷新页面（不是重新打开一个新地址）。在 **设置 → 微信** 中应能看到设置页；「设置 → 插件 → 可配置插件」里也会出现同一份配置表单。

安装回执只证明磁盘安装与解析结果，不证明浏览器已加载插件；页面里的设置页才是激活证据。

## 4. 配置

第一次打开时状态会是「未配置」。按顺序：

1. WechatPad 地址 + Key；
2. 测试连接；
3. 私聊白名单（默认策略为仅白名单）；
4. 保存。

保存经 dsh 的 Settings 服务写入当前 profile 的 Cordis patch，Loader 随即重建本插件；不需要重启 dsh。但如果 Key 改动导致连接失败，重启一次更直观。

## 5. 卸载

```sh
dsh plugin --profile web remove @dsh/wechatpad --ignore-scripts
```

然后重启 `dsh web`。原始 profile 文件在 `~/.dsh/profiles/web/.plugin-manager/wechatpad-backup-*`；正常卸载请用 dsh 管理器，不要整目录覆盖旧备份，以免冲掉安装之后其他插件的改动。

## 6. 排查

| 现象 | 检查 |
| --- | --- |
| 设置里没有「微信」 | `dsh.profile.bundles` 是否含 `@dsh/wechatpad`；是否重启并刷新 |
| 状态「未配置」 | Key 没保存成功，或保存后 Loader 报错（看 dsh 启动日志） |
| 状态「出错」 | 先点测试连接；确认 Pad 可从 dsh 进程访问（同一台机器/同一网段） |
| 发消息没反应 | 私聊是否在白名单；群聊策略默认忽略；群里是否 @ 了机器人 |
| 收不到推送 | 用 `curl "<pad>/login/GetLoginStatus?key=..."` 看 Pad 是否在线；webhook 模式看 Pad 的 `/message/GetCallback` |

日志前缀为 `[wechatpad]`，在 dsh 的日志里查看。
