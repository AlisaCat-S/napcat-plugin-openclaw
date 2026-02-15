# napcat-plugin-openclaw

将 QQ 变为 [OpenClaw](https://openclaw.ai) AI 助手通道。

通过 OpenClaw Gateway 的 WebSocket RPC 协议（`chat.send`）通信，所有斜杠命令由 Gateway 统一处理，与 TUI / Telegram 体验完全一致。

## ✨ 功能

- **私聊全透传** — 白名单内用户的私聊消息直接转发给 OpenClaw Agent
- **群聊 @触发** — 群聊中仅 @bot 时触发回复（可配置）
- **斜杠命令** — `/status`、`/model`、`/think`、`/verbose`、`/new`、`/stop` 等，与 OpenClaw TUI 完全一致
- **图片/文件支持** — QQ 发图/文件自动下载缓存，Agent 可直接读取；Agent 回复中的 `MEDIA:` 标签自动发送图片/文件到 QQ
- **引用消息解析** — 自动解析回复引用的原始消息内容（支持多媒体、CQ 码解析），可配置解析深度
- **表情解析** — QQ 系统表情转为中文名称，商城大表情可下载为图片传给后端（需开启缓存）
- **发送者身份注入** — 自动将发送者昵称、QQ 号、群名等信息注入消息上下文
- **群聊回复增强** — 可配置回复时 @发送者、引用原消息，自动去重
- **消息防抖** — 快速连发的消息自动合并为一条请求（可配置时间窗口）
- **发送速率限制** — 全局消息发送队列，限制 0.5 msg/s（每 2 秒 1 条），防止风控
- **输入状态** — 私聊中显示"对方正在输入..."
- **WS 心跳自动重连** — 15 秒心跳检测，断线 5 秒后自动重连，无需人工干预
- **群聊 Session 模式** — 可选每人独立 session 或群共享 session
- **权限控制** — 用户白名单/黑名单、群白名单、管理员 QQ、指令仅管理员等
- **WebUI 配置面板** — 在 NapCat WebUI 中直接配置所有选项
- **多媒体缓存** — 可配置缓存目录、大小上限、TTL 自动清理
- **CLI 回退** — Gateway WS 断连时自动回退到 `openclaw agent` CLI

## 📦 安装

### 方式一：从 Release 下载

1. 前往 [Releases](https://github.com/CharTyr/napcat-plugin-openclaw/releases) 下载最新 zip
2. 解压到 NapCat 插件目录：`napcat/plugins/napcat-plugin-openclaw/`
3. 在插件目录执行 `npm install --production` 安装依赖
4. 重启 NapCat

### 方式二：从源码构建

```bash
git clone https://github.com/CharTyr/napcat-plugin-openclaw.git
cd napcat-plugin-openclaw
pnpm install
pnpm build
# 将 dist/ 目录复制到 napcat/plugins/napcat-plugin-openclaw/
```

## ⚙️ 配置

在 NapCat WebUI 插件配置面板中设置，或编辑配置文件：

### OpenClaw 连接

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `openclaw.token` | OpenClaw Gateway 认证 Token | （必填） |
| `openclaw.gatewayUrl` | Gateway WebSocket 地址 | `ws://127.0.0.1:18789` |
| `openclaw.cliPath` | openclaw CLI 可执行文件路径 | `/root/.nvm/.../openclaw` |

### 行为设置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `behavior.privateChat` | 是否接收私聊消息 | `true` |
| `behavior.groupAtOnly` | 群聊仅 @bot 触发 | `true` |
| `behavior.adminQQ` | 管理员 QQ 号（逗号分隔） | 空 |
| `behavior.commandAdminOnly` | / 指令仅管理员可用 | `false` |
| `behavior.userWhitelist` | 用户白名单（QQ号，逗号分隔） | 空（全部允许） |
| `behavior.groupWhitelist` | 群白名单（群号，逗号分隔） | 空（全部允许） |
| `behavior.groupBypassUserWhitelist` | 白名单群忽略用户白名单 | `false` |
| `behavior.userBlacklist` | 用户黑名单（QQ号，逗号分隔） | 空 |
| `behavior.debounceMs` | 消息防抖时长（毫秒） | `2000` |
| `behavior.resolveReply` | 解析引用消息内容 | `true` |
| `behavior.replyMaxDepth` | 引用解析最大深度 | `1` |
| `behavior.groupSessionMode` | 群聊 Session 模式 | `user` |
| `behavior.replyAtSender` | 群聊回复时 @发送者 | `true` |
| `behavior.replyQuoteMessage` | 群聊回复时引用原消息 | `false` |

### 多媒体缓存

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `media.cacheEnabled` | 启用多媒体缓存模式 | `false` |
| `media.parseMface` | 商城表情下载为图片（需开启缓存） | `true` |
| `media.cachePath` | 缓存目录路径 | `/tmp/napcat/.../download` |
| `media.cacheMaxSizeMB` | 缓存上限（MB） | `2048` |
| `media.cacheTTLMinutes` | 缓存过期时间（分钟） | `60` |

### 群聊 Session 模式

- **`user`**（默认）— 每个群成员拥有独立的对话上下文
- **`shared`** — 整个群共享同一个对话上下文，所有成员的消息都在同一个 session 中

## 🔧 前置要求

- [NapCat](https://github.com/NapNeko/NapCatQQ) >= 4.14.0
- [OpenClaw](https://openclaw.ai) Gateway 运行中（本地或远程）
- Node.js >= 18

## 📋 可用命令

所有 OpenClaw 斜杠命令均可直接使用：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/new` / `/clear` | 新建对话 |
| `/stop` | 终止当前任务 |
| `/status` | 查看会话状态 |
| `/model <id>` | 查看/切换模型 |
| `/think <level>` | 设置思考级别 |
| `/verbose on\|off` | 切换详细模式 |
| `/context` | 查看上下文信息 |
| `/whoami` | 显示身份信息 |
| `/commands` | 列出全部命令 |

## 🏗️ 技术架构

```
QQ 用户 ←→ NapCat ←→ 本插件 ←→ OpenClaw Gateway (WS RPC)
                                       ↕
                                   AI Agent (Claude, etc.)
```

- **入站消息**：插件通过 Gateway 的 `chat.send` RPC 方法发送消息
- **回复接收**：监听 `chat` event 的 `final` 帧获取完整回复（非流式，一次性返回）
- **图片处理**：下载到缓存目录，Agent 通过 `read` tool 直接读取
- **认证协议**：Gateway WS challenge-response 协议
- **心跳机制**：15s ping/pong + 30s 超时检测 + 5s 自动重连
- **速率控制**：全局发送队列，2s 间隔，防止 QQ 风控

## 📝 License

MIT © [CharTyr](https://github.com/CharTyr), [BoxyCat](https://github.com/BoxyCat)
