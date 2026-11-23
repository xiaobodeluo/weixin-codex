# weixin-codex

把微信接到本机 Codex CLI 的常驻桥接。微信里对话的是**主管**，实际执行交给独立 **worker**，所以任务运行期间仍然可以继续聊天、追问或改变方向。

> [English](./README.en.md)

## 为什么是主管 + worker

旧版每次微信消息都会直接进入同一个 Codex 会话。任务跑多久，桥就等多久；用户再发消息也只能排队，无法一边工作一边和它说话。

`v0.2.0` 把通信和执行拆开:

- **主管会话**常驻，只负责聊天、判断、拆任务、派活和汇总。
- **工作会话**按任务独立启动，实际查资料、读写文件、运行命令或操作软件。
- 微信长轮询不再被任务执行阻塞。
- 默认最多并行 2 个 worker，可配置。
- 任务运行期间每 2 分钟发送一次进度提示。
- 完成、失败或取消后，worker 结果回到主管，由主管用微信口吻汇报。

## 特性

- 微信 iLink Bot 长轮询，收发文字消息
- 主管/worker 分离，聊天不打断执行
- 任务队列、并发控制、超时、取消和进程树终止
- 任务结果持久化到 `state/jobs.json`
- 图片下载、AES 解密、视觉转录后交给主管
- 可主动向微信发送图片、视频和文件
- 可选 Breeze TTS 语音回复
- 会话过大或接口失败时自动重试、切换新会话
- 无第三方运行时依赖，仅使用 Node 内置模块

## 架构

```text
微信用户
   │
   ▼
腾讯 iLink Bot 后端
   │ getupdates 长轮询
   ▼
weixin-codex.mjs
   ├── 主管队列 ──> Codex 主管会话
   │                  │ dispatch / cancel / reply
   │                  ▼
   └──────────────> worker 队列
                      ├── worker #1
                      ├── worker #2
                      └── ...
                            │ job_finished
                            ▼
                       主管汇总后发回微信
```

主管使用受约束的 JSON 决策:

```json
{
  "action": "dispatch",
  "reply": "收到，我安排去查。",
  "task": "查询并核实……",
  "job_id": ""
}
```

`action` 可选 `reply`、`dispatch`、`cancel`。结构定义在
[`manager-response.schema.json`](./manager-response.schema.json)。

## 前置条件

- Node.js 22 或更高版本
- 已安装并登录 Codex CLI
- 已安装 OpenClaw 和 `openclaw-weixin`
- 可选：OpenAI 兼容视觉模型，用于图片转录
- 可选：Breeze TTS 服务和随仓库提供的 `vendor/silk-wasm`

## 1. 登录微信

```bash
npm install -g openclaw
npx -y @tencent-weixin/openclaw-weixin-cli@latest install
```

扫码完成后，登录凭证位于:

```text
~/.openclaw/openclaw-weixin/accounts/
├── <ACCOUNT_ID>.json
├── <ACCOUNT_ID>.sync.json
└── <ACCOUNT_ID>.context-tokens.json
```

随后关闭 OpenClaw 自带的微信通道，避免两个客户端争抢消息:

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled false
openclaw gateway restart
```

## 2. 配置

```bash
cp config.example.json config.json
```

至少填写 `accountId`，并让 `codexNode` / `codexCli` 指向本机 Codex CLI。

原生可执行方式:

```json
{
  "codexNode": "codex",
  "codexCli": ""
}
```

npm 包装方式:

```json
{
  "codexNode": "node",
  "codexCli": "C:/path/to/node_modules/@openai/codex/bin/codex.js"
}
```

主要配置:

| 键 | 默认值 | 说明 |
|---|---:|---|
| `accountId` | 必填 | OpenClaw 微信账号 ID |
| `accountDir` | `~/.openclaw/openclaw-weixin/accounts` | 微信登录凭证目录 |
| `stateDir` | `./state` | 本地运行状态 |
| `workspaceDir` | 脚本所在目录 | worker 的 Codex 工作目录 |
| `managerWaitMs` | `120000` | 主管单轮超时 |
| `waitMs` | `600000` | worker 单任务超时 |
| `jobConcurrency` | `2` | 并行 worker 数，范围 1–4 |
| `jobProgressMs` | `120000` | 运行中进度提示间隔 |
| `codexRetryMs` | `2000` | 失败重试间隔 |
| `vision*` | 见示例 | 图片视觉转录配置 |
| `breezeTts` | 关闭 | 可选语音回复配置 |

不要把 `config.json`、`state/`、日志或登录凭证提交到仓库。`.gitignore` 已默认排除。

## 3. 运行

```bash
npm start
```

Windows 可以使用:

```text
run-client-hidden.vbs
```

它会通过 `run-client.cmd` 在隐藏窗口启动，并把日志写入 `client.log` 和 `client.err.log`。

## 4. 测试

```bash
npm test
```

测试覆盖媒体指令解析和主管 JSON 决策解析。

实际联调时:

1. 在微信里发一个闲聊问题，主管应直接回复。
2. 发一个会运行较久的任务，主管应先接单。
3. worker 运行时继续发消息，主管仍然可以回答。
4. 任务结束后，主管应自动发送结果。

## 主动发送媒体

主管或 worker 的最终回复可以包含独占一行的指令:

```text
[[send-image: C:\绝对路径\图片.png]]
[[send-video: C:\绝对路径\视频.mp4]]
[[send-file:  C:\绝对路径\文件.zip]]
```

桥接会移除指令行，将剩余文字作为聊天消息发送，再把每个本地文件上传到微信 CDN 并作为真实媒体消息发出。

## 状态文件

| 文件 | 用途 |
|---|---|
| `state/codex-manager-session.json` | 常驻主管会话 ID |
| `state/jobs.json` | 排队、运行、完成和失败任务 |
| `state/job-replies/<id>.txt` | worker 最终输出 |
| `state/seen-ids.json` | 微信消息去重 |
| `state/images/` | 入站图片缓存 |
| `state/voice/` | Breeze TTS 中间文件 |
| `state/manager-reply.txt` | 主管最近一轮结构化回复 |

桥重启时，旧的运行中任务会标记为中断，不会在无提示的情况下重新执行。

## 取消和超时

用户可以直接说“停掉 #任务号”。主管会返回 `cancel` 决策，桥接终止对应的 Codex 进程树。

任务默认 10 分钟超时。主管单轮默认 2 分钟超时。超时不会卡住微信长轮询。

## 安全边界

- 微信账号 token、context token、API Key 和 `config.json` 不应进入 Git。
- worker 默认使用 `--dangerously-bypass-approvals-and-sandbox`，会继承本机 Codex 的工具权限。只连接可信微信账号。
- 主管使用只读 sandbox，但它仍能读取本机文件；主管提示要求它只做调度，不直接执行任务。
- 这是非官方、未文档化的微信 iLink Bot 协议，接口可能变化。

详见 [SECURITY.md](./SECURITY.md)。

## License

[MIT](./LICENSE)
