# weixin-codex

把微信接到本机 Codex 的常驻桥接。微信里的对话默认进入一个持续保留的
Codex app-server 线程；任务运行中继续发消息，会作为 steering 接进当前
工作，不再只能排队等待。

> 当前版本：`0.3.0`。英文说明见 [README.en.md](./README.en.md)。

这是一个自托管工具，不是腾讯、微信或 OpenAI 的官方产品。它依赖未公开的
微信 iLink Bot 接口，接口或登录方式可能随时变化。

## 新版能力

- **连续 app-server 会话**：默认使用 Codex app-server，保留线程并支持
  `turn/steer`。任务跑着时仍可补充要求、纠正方向或追问。
- **主管 / worker 降级路径**：app-server 不可用时，自动回落到主管会话
  加独立 worker 的队列结构。
- **任务不阻塞微信**：长轮询、主管决策和工作执行分离。
- **文字、图片、文件和视频**：支持入站图片、主动发送图片/视频/文件。
- **微信频道 CLI**：可从任意 Codex/终端会话列出联系人、轮询、发文字和媒体。
- **可选视觉转录与语音回复**：OpenAI 兼容视觉接口；可选 Breeze TTS。
- **可复现配置**：账号、路径和权限配置与源码分离；没有第三方运行时依赖。
- **隐私清理**：日志只显示掩码用户 ID，不输出 token 或 context token。

## 工作方式

```text
微信
  │  iLink Bot getupdates / sendmessage
  ▼
weixin-codex.mjs
  ├── 默认：Codex app-server 持续线程
  │      └── turn/steer 接入运行中的新消息
  │
  └── 降级：主管会话 ──> 独立 worker 队列
                         └── 并发、超时、取消、结果回传
```

主管模式的输出被限制为结构化动作：

```json
{
  "action": "dispatch",
  "reply": "收到，我安排去查。",
  "task": "查询并核实……",
  "job_id": ""
}
```

可选动作是 `reply`、`dispatch`、`cancel`。结构定义见
[`manager-response.schema.json`](./manager-response.schema.json)。

## 前置条件

- Node.js 22 或更高版本
- 已安装并登录 Codex CLI
- 已安装 OpenClaw 和 `openclaw-weixin`，且完成一次微信扫码登录
- 可选：OpenAI 兼容的视觉模型，用于图片转录
- 可选：Breeze TTS 服务；语音编码所需的 `silk-wasm` 已随仓库提供

## 快速开始

### 1. 获取项目

```bash
git clone https://github.com/xiaobodeluo/weixin-codex.git
cd weixin-codex
```

### 2. 登录微信

```bash
npm install -g openclaw
npx -y @tencent-weixin/openclaw-weixin-cli@latest install
```

扫码后，登录凭证通常在：

```text
~/.openclaw/openclaw-weixin/accounts/
├── <ACCOUNT_ID>.json
├── <ACCOUNT_ID>.sync.json
└── <ACCOUNT_ID>.context-tokens.json
```

关闭 OpenClaw 自带的微信通道，避免两个客户端争抢消息：

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled false
openclaw gateway restart
```

### 3. 创建配置

PowerShell：

```powershell
Copy-Item config.example.json config.json
```

或 Unix shell：

```bash
cp config.example.json config.json
```

至少填写 `accountId`。`accountDir`、`stateDir` 和 `workspaceDir` 留空时会
使用安全的本机默认值；相对路径以仓库目录为基准。

Codex CLI 有两种常见配置。

使用原生 `codex` 命令：

```json
{
  "codexNode": "codex",
  "codexCli": ""
}
```

使用 Node 包装的 Codex：

```json
{
  "codexNode": "node",
  "codexCli": "C:/path/to/node_modules/@openai/codex/bin/codex.js"
}
```

### 4. 检查环境

```bash
npm run doctor
```

`doctor` 会检查 Node、配置、微信账号文件、Codex CLI 和语音编码资源，
不会打印 token。第一次尚未收到微信消息时，`context tokens` 可能显示
`FAIL`；启动桥后给机器人发一条消息即可生成。

### 5. 启动

```bash
npm start
```

Windows 可双击 [`run-client-hidden.vbs`](./run-client-hidden.vbs)。它会在
隐藏窗口运行 `run-client.cmd`，日志写到仓库目录下的 `client.log` 和
`client.err.log`。

## 配置项

| 键 | 默认值 | 说明 |
|---|---:|---|
| `accountId` | 必填 | OpenClaw 微信账号 ID |
| `accountDir` | `~/.openclaw/openclaw-weixin/accounts` | 微信登录凭证目录 |
| `stateDir` | `./state` | 去重、任务、图片和语音等运行状态 |
| `workspaceDir` | 仓库目录 | Codex 工作目录 |
| `engine` | `app-server` | 主引擎；当前版本也保留 `manager` 降级 |
| `agentEffort` | `high` | app-server 推理强度 |
| `waitMs` | `600000` | 单次 worker 任务超时 |
| `managerWaitMs` | `120000` | 主管单轮超时 |
| `jobConcurrency` | `2` | worker 并发数，范围 1–4 |
| `jobProgressMs` | `120000` | worker 进度提示间隔 |
| `messageBatchMs` | `1500` | 连续文字合并等待时间 |
| `imageBatchMs` | `5000` | 图片和补充文字合并等待时间 |
| `mediaDedupeMs` | `900000` | 相同媒体重复发送抑制窗口 |
| `codexRetryMs` | `2000` | Codex 失败重试间隔 |
| `codexNode` | `codex` | Codex 可执行文件，或运行 JS 的 Node |
| `codexCli` | 空 | 可选的 `codex.js` 路径 |
| `vision*` | 见示例 | 图片转录接口、模型、超时和重试 |
| `managerHistoryMessages` | `12` | 主管 API 保留的最近消息数 |
| `managerApi` | 关闭 | manager 降级时的 OpenAI 兼容服务配置 |
| `breezeTts` | 关闭 | 可选 Breeze TTS 配置 |

环境变量可以覆盖关键路径：

| 变量 | 作用 |
|---|---|
| `WEIXIN_CONFIG` | 指定 `config.json` 的绝对路径 |
| `WEIXIN_ACCOUNT_ID` | 覆盖账号 ID |
| `WEIXIN_ACCOUNT_DIR` | 覆盖微信凭证目录 |
| `WEIXIN_STATE_DIR` | 覆盖运行状态目录 |
| `WEIXIN_TO` | 发送工具默认微信联系人 ID |
| `DEEPSEEK_API_KEY` | 图片视觉接口或 manager API 的密钥 |

`config.json`、`state/`、日志和登录凭证已被 `.gitignore` 排除。不要强制
提交这些文件。

## 微信频道 CLI

频道 CLI 与常驻桥共用 `config.json`、账号游标和 `state/`，适合由 Codex
桌面会话或其他本地自动化驱动微信。

```bash
# 查看已有联系人
node wechat-channel.mjs contacts

# 长轮询最多 10 秒
node wechat-channel.mjs poll --seconds 10

# 发送文字
node wechat-channel.mjs send --text "测试消息"

# 指定联系人和媒体类型
node wechat-channel.mjs send-media \
  --to "<CONTACT_ID>" \
  --path "C:/absolute/path/report.pdf" \
  --kind file \
  --caption "文件发你"
```

每个命令向 stdout 输出一个 JSON 对象。不要同时启动两个桥接或轮询进程
消费同一个微信账号。

## 发送媒体

Codex 最终回复可包含独占一行的媒体指令：

```text
[[send-image: C:\absolute\picture.png]]
[[send-video: C:\absolute\clip.mp4]]
[[send-file: C:\absolute\document.pdf]]
```

桥会删除指令行，把其余文字作为聊天消息发送，再把文件上传到微信 CDN。
相同路径、大小和修改时间在去重窗口内只发送一次。

也可以直接运行独立工具：

```bash
node send-text.mjs --to "<CONTACT_ID>" --text "hello"
node send-image.mjs --to "<CONTACT_ID>" "C:/absolute/picture.png"
node send-video.mjs --to "<CONTACT_ID>" "C:/absolute/clip.mp4"
node send-video.mjs --to "<CONTACT_ID>" --as-file "C:/absolute/archive.zip"
```

省略 `--to` 时，优先使用 `WEIXIN_TO`、最近一次收到的联系人，最后才回退到
账号自身的用户 ID。

## 状态和恢复

| 文件 | 用途 |
|---|---|
| `state/codex-app-thread.json` | app-server 持续线程 ID |
| `state/codex-manager-session.json` | 主管会话 ID |
| `state/jobs.json` | 降级模式的任务队列与最近结果 |
| `state/job-replies/<id>.txt` | worker 最终输出 |
| `state/seen-ids.json` | 微信消息去重 |
| `state/images/` | 入站图片缓存 |
| `state/voice/` | TTS 中间文件 |

桥重启时，旧版本中仍在运行的任务会标记为中断，不会静默重复执行。

## 测试

```bash
npm test
```

测试包含所有 `.mjs` 的语法检查、JSON 解析，以及媒体指令、主管决策和账号
工具参数。

CI 在 Node.js 22 和 24 上运行相同的测试。

## 安全边界

微信发来的消息实际上是一个远程执行入口。默认 app-server 和 worker 会以
本机 Codex 的完整工具权限运行，可读写文件、运行命令和联网。

- 只连接你完全信任的微信账号。
- 把仓库放在专用目录或隔离环境中。
- 不要公开 `config.json`、OpenClaw 账号文件、日志或 `state/`。
- token 泄露后立即重新扫码登录并轮换凭证。
- 如果只需要通信、不需要执行，请移除或收紧 app-server/worker 权限。

更多说明见 [SECURITY.md](./SECURITY.md)。

## License

[MIT](./LICENSE)。随仓库的 `vendor/silk-wasm` 使用其自身 MIT 许可证。
