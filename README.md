# Pi QQ Bot

[![CI](https://github.com/ClearEra/qq-pi-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/ClearEra/qq-pi-bot/actions/workflows/ci.yml)

> 初期实现，尚未完成真实 QQ 收发验收。测试使用本地模拟 Gateway 和 Pi faux provider，不代表已上线。

## 开发流程

所有变更遵循 **Issue → 分支 → PR → CI 构建/测试 → 合并 → 部署**，详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。不要直接向 `main` 提交，也不要从 PR 分支部署。CI 不持有 QQ/模型密钥，不连接个人 Mac。

基于 Pi 1.0 + `@earendil-works/pi-durable` 的 QQ 官方机器人服务。没有 OpenClaw 运行依赖。建议工程位于 `~/Projects/qq-pi-bot`，不放在 Obsidian Vault/iCloud 内。需要 Node.js >=22.19.0；当前支持 macOS Keychain 和 LaunchAgent 部署。

## 组成

- Pi Durable SQLite：持久保存每个私聊/群聊的独立会话、消息任务和待处理工具调用，重启后恢复。
- Pi 的 provider/model：读取 `~/.pi/agent/models.json` 和 `settings.json`，不保存额外模型 API key。
- QQ 官方 WebSocket Gateway + REST：`bots.qq.com` 换 token，`api.sgroup.qq.com` 用于消息和 Gateway。
- Keychain：QQ AppSecret 存入 macOS Keychain，不写入项目文件或日志。
- SQLite inbox/outbox：消息去重、会话路由、待发送回复和恢复游标。
- 本机资料编辑：`http://127.0.0.1:18797` 修改角色和基础信息。文件变化会在下一次 Pi 请求时生效。
- macOS LaunchAgent：用户登录后自动拉起并自动重启；`caffeinate` 阻止系统闲置睡眠。

## 安装

先到 QQ 开放平台创建凭据；如果 AppSecret 曾公开，务必先撤销/轮换。不要把密钥写入项目、Issue、PR 或聊天。确认 Pi 的 `~/.pi/agent/models.json` 与 `settings.json` 中有可用 provider/model，然后运行：

```sh
cd ~/Projects/qq-pi-bot
npm ci
npm run setup
npm run deploy
```

设置程序会提示输入 AppID 和 Pi provider/model；AppSecret 由 `security` 命令在 macOS Keychain 的安全输入提示中收取。之后检查服务：

```sh
npm run service-status
open http://127.0.0.1:18797
```

部署必须从干净、已合并且 CI 通过的最新 `main` 执行，需安装并登录 GitHub CLI (`gh`)。`npm run install-service` 同样经过部署门禁。每次部署导出已合并提交到 `~/.local/share/qq-pi-bot/releases/<commit>-<suffix>/` 并在该独立目录安装依赖和构建；LaunchAgent 不运行开发 checkout，切换开发分支不会改变已部署代码。缺少配置或 Keychain 凭据时会在安装服务前停止。

服务日志：`~/.pi/qq-bot/logs/`。设置、角色和数据：`~/.pi/qq-bot/`。QQ 事件库：`data/qq-events.sqlite`；Pi Durable 会话库：`data/pi-durable.sqlite`。部署记录：`~/.pi/qq-bot/deployment.json`。

目前模型加载器支持 `~/.pi/agent/models.json` 中定义的 OpenAI-compatible provider（`openai-completions`），不执行其中的 Shell 凭据命令，也不支持 Pi OAuth 登录凭据。默认 provider/model 来自 Pi 的 `settings.json`，设置程序会保存选择。

## QQ 平台设置

1. 在 QQ 开放平台为机器人启用 C2C 消息事件。
2. 要接收群里所有未 @ 消息，在开放平台申请/启用“接收所有消息”权限；群主/群设置可能还需要允许该机器人读取群内消息。否则 QQ 只会投递 `GROUP_AT_MESSAGE_CREATE`。
3. 将机器人加入目标群聊并确认群聊场景开放。
4. 模型只接收与 QQ 对话有关的文本上下文，只能调用 `reply_decision`，没有 shell、文件或其他工具权限。每条消息由模型选择 `reply` 或 `silent`。

群聊全量消息会把群内消息内容发送到配置的 Pi provider 以生成判断与回复。只应将机器人加入群成员知情且允许自动化处理消息的群聊。可以在 `~/.pi/qq-bot/config/local.json` 禁用私聊/群聊；也可以改 `groupMode` 为 `mention-only`。

## 修改人设和基础信息

浏览器打开 `http://127.0.0.1:18797`，编辑“基础信息”和“角色设定”后保存。对应文件：

- `~/.pi/qq-bot/config/IDENTITY.md`
- `~/.pi/qq-bot/config/SOUL.md`

## 运行限制

此服务是 Pi Durable 在本机的持久运行方式，SQLite 能在进程崩溃后恢复状态；LaunchAgent 负责拉起进程。它不能保证关机、注销、休眠、断网或 QQ 平台故障期间在线。macOS LaunchAgent 需要用户登录后才能运行；`caffeinate` 可阻止闲置睡眠，但不能阻止合盖睡眠、关机或网络中断。真正的 24 小时可用性需要一台始终供电、联网且不睡眠的主机，或将 Pi 服务部署到常驻服务器。

QQ 被动群聊回复时限约 5 分钟，私聊约 60 分钟。服务默认在约 210 秒内处理模型判断（可配置为 1–240 秒）；过期的工作标记失效，不转为无触发的主动消息。平台需要在控制台授权全量群消息，客户端传 intents 不能绕过权限。

## 运维

```sh
npm run service-status
npm run uninstall-service
```

运行测试：

```sh
npm test
npm audit --omit=dev
```

Pi Durable 为实验性 API；升级前停止服务，备份整个 `~/.pi/qq-bot/data/`（包括 WAL 文件）并执行测试。QQ 事件库与 Pi Durable 会话库分开，避免同进程同步 SQLite 查询阻塞异步事务。

## 可靠性与隐私边界

- 同一个会话的消息按序处理；消息 ID 用于去重，Pi submission 的 requestId 避免已接纳输入在重启后重复调用模型。
- inbox/outbox 在本地持久化；QQ 回复重试使用相同的 `msg_id`/`msg_seq`。不能保证端到端 exactly-once：平台已接收但本地未记录成功时，最终行为取决于平台去重。
- 过期消息不会转成主动消息；离线时平台未投递或无法回放的消息无法恢复。
- 聊天原文、角色提示和模型返回会保存在本机 SQLite；模型 provider 会接收对话上下文。当前没有自动数据保留/清理策略，操作者须管理磁盘、数据删除和群成员同意。
- 角色编辑页只监听 loopback，并校验 Host/Origin；不应通过代理开放到公网。同一操作系统用户的其他本地程序仍可能访问它。

## 参考

- [QQ 开放平台官方文档](https://bot.q.qq.com/wiki/develop/api-v2/)
- [腾讯官方 QQ SDK](https://github.com/tencent-connect/qqbot-nodejs)：协议、事件和重连实现参考。
- [Pi](https://github.com/earendil-works/pi)：模型、扩展和 Durable 持久状态运行时。
- [腾讯官方 OpenClaw QQ 适配器](https://github.com/tencent-connect/openclaw-qqbot)：仅作同类项目/平台接入参考，本项目不依赖或运行 OpenClaw。
