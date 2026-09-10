# weixin-codex

把微信消息直接接到**本机 Codex CLI**:你在微信里发的消息会进入一个 Codex 会话,Codex 的回复原样发回微信。

> [English](./README.en.md)

> 定位:一个"轻量、自托管"的微信 ↔ AI 助手桥。它**不**经过 OpenClaw 的 agent 运行时,只用 openclaw-weixin 插件产生的登录凭证,直接调用微信 iLink Bot 后端协议(`getupdates` 长轮询 + `sendmessage`),把本地 Codex CLI 当作"大脑"。
>
> 区别:另一类方案(如 dsh-weixin-direct)把 DeepSeek Harness 当大脑;本项目用的是 Codex CLI,和你在桌面 Codex 里用的是同一套模型/权限/工具。

## 特性

- 微信 ↔ Codex 直连:共享同一个 Codex 会话上下文,agent 在本机执行,回复回传微信
- 纯文字消息收发,支持"正在输入"状态提示
- **图片消息**:从微信 CDN 下载解密 → 交给视觉模型转录 → 转录内容注入 Codex 会话,由 Codex 回复
- 消息去重、同步游标持久化(重启不丢消息、不重放)
- 崩溃自愈:Codex 不可用/回复超时时微信侧会收到明确提示
- 线程膨胀自愈:当续用的会话过大导致模型接口报错(如 HTTP 413)时,自动切到新线程重试一次
- **Codex 可主动回媒体**:回复里放一行指令,即可把本机图片/视频/文件发到微信(见下文)
- 无第三方依赖(仅用 Node 内置模块)

## 架构

```
微信用户
   │  (1) 发消息
   ▼
腾讯 iLink Bot 后端 (ilinkai.weixin.qq.com)
   │  (2) 长轮询 getupdates(携带本地登录 token)
   ▼
weixin-codex.mjs(本仓库,常驻进程)
   │  (3) spawn `codex exec …`(同一台机器、同一份 Codex 配置)
   ▼
Codex CLI 会话
   │  (4) 解析 --json 事件流,提取最终回复文本
   ▼
weixin-codex.mjs
   │  (5) sendmessage(携带 context_token)
   ▼
微信用户收到回复
```

**图片消息链路**:

```
微信用户发图
   │  (a) image_item.media(encrypt_query_param / full_url + aes_key)
   ▼
weixin-codex.mjs 从微信 CDN 下载密文
   │  https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=…
   │  (b) AES-128-ECB 解密
   ▼
视觉模型(默认 DeepSeek,可换任意 OpenAI 兼容多模态接口)
   │  完整转录图片内容(文字/数字/表格逐格)
   ▼
转录文本注入 Codex 会话(同时给出本机保存的原图路径)
   ▼
Codex 处理并回复 → 发回微信
```

## 前置条件

- **Node.js ≥ 22**(用到全局 `fetch`;22 以下需额外 flag)
- **已安装并登录 Codex CLI**(`codex` 可执行,或 npm 包 `@openai/codex` 的 `bin/codex.js`)
- **已安装 OpenClaw + openclaw-weixin 微信插件,并完成过一次扫码登录**(用于产生凭证。本项目把 OpenClaw 只当"登录器")
- 图片功能额外需要:一个支持图片输入的 OpenAI 兼容视觉模型(默认 DeepSeek `deepseek-v4-flash-vision-exp`)

## 快速开始

### 1. 安装 OpenClaw + 微信插件并扫码登录

```bash
npm install -g openclaw
npx -y @tencent-weixin/openclaw-weixin-cli@latest install
```

安装过程中终端会显示二维码(或给出 `liteapp.weixin.qq.com` 链接),用手机微信扫码授权。成功后凭证写入:

```
~/.openclaw/openclaw-weixin/accounts/
├── <ACCOUNT_ID>.json                # token / baseUrl / userId
├── <ACCOUNT_ID>.sync.json           # 长轮询游标
└── <ACCOUNT_ID>.context-tokens.json # 每个对端用户的 context_token
```

记下 `<ACCOUNT_ID>`(形如 `xxxxxxxx-im-bot`)。

### 2. 停用 OpenClaw 的微信通道(关键)

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled false
openclaw gateway restart
```

> 不执行这步会出现:双客户端抢同一条消息 / 一条消息收到两个回复。
>
> 需要重新扫码时:先 `openclaw config set plugins.entries.openclaw-weixin.enabled true` 并重启网关,再 `openclaw channels login --channel openclaw-weixin`,完成后再次停用。

### 3. 克隆并配置

```bash
git clone <your-repo> weixin-codex
cd weixin-codex
cp config.example.json config.json
```

编辑 `config.json`,至少填 `accountId`,并把 `codexNode` / `codexCli` 指向你的 Codex CLI:

```jsonc
{
  "accountId": "xxxxxxxx-im-bot",

  // 方式 A(原生可执行):直接指向 codex 本体,codexCli 留空
  "codexNode": "codex",
  "codexCli": "",

  // 方式 B(npm 包装):用 node 跑 @openai/codex 的 bin
  // "codexNode": "node",
  // "codexCli": "C:/path/to/node_modules/@openai/codex/bin/codex.js"
}
```

> 只需填一种方式,另一个删掉即可。

### 4. (可选)配置图片功能

设置环境变量 `DEEPSEEK_API_KEY`(或写入 `~/.dsh/.credentials.yaml`),并确认 `config.json` 的 `visionBaseUrl` / `visionModel`。不配也能跑,发图会收到"图片识别暂时不可用"类提示。

### 5. 运行

```bash
node weixin-codex.mjs
```

日志输出到 stdout;用 `run-client.cmd` 等启动器时会重定向到 `client.log`。

### 6. 测试

在微信里给 bot 发一条消息(如"你好"),日志应出现:

```
[info] starting, account=... baseUrl=... userId=...
[info] poll got 1 msg(s)
[info] msg from=...@im.wechat len=2 images=0 mid=... 
[info] replied to=...@im.wechat len=...
```

发一张图片,应额外出现 `image downloaded …`、`vision transcript len=…`。

## 配置参考(config.json)

| 键 | 默认值 | 说明 |
|---|---|---|
| `accountId` | 无(必填) | 微信账号 ID,对应 accounts 目录下的文件名前缀 |
| `accountDir` | `~/.openclaw/openclaw-weixin/accounts` | 凭证目录(一般无需改) |
| `stateDir` | 脚本目录下 `state/` | 去重记录、图片缓存等本地状态 |
| `workspaceDir` | 脚本目录 | Codex 会话的工作目录(决定加载哪个 `AGENTS.md`) |
| `waitMs` | `600000` | 等待 Codex 回复的超时(毫秒) |
| `codexNode` | `node` | 启动 Codex 的可执行文件(见下方"两种启动方式") |
| `codexCli` | 空 | 传给 `codexNode` 的脚本路径;原生 codex 时留空 |
| `visionBaseUrl` | `https://api.deepseek.com` | 视觉模型接口地址(OpenAI 兼容) |
| `visionModel` | `deepseek-v4-flash-vision-exp` | 主视觉模型 |
| `visionModels` | `[visionModel]` | 依次重试的视觉模型列表 |
| `visionMaxTokens` | `1024` | 视觉模型最大输出 token |

**两种启动方式**:脚本执行 `spawn(codexNode, codexCli ? [codexCli, ...args] : args)`。

- 原生: `codexNode = "codex"`, `codexCli = ""` → 相当于 `codex exec …`
- npm: `codexNode = "node"`, `codexCli = ".../codex.js"` → 相当于 `node codex.js exec …`

## 模型分工

文字消息**永远**走 Codex 主会话;只有图片本身交给视觉模型"看"。视觉模型不直接回复用户——它是 Codex 的"眼睛",转录结果喂给主会话,由 Codex 决定怎么回。图片后跟进的文字同样走主会话。

## 让 Codex 主动回图 / 回视频 / 回文件

除了回文字,Codex 还能把**本机文件**直接发到微信——只要在回复里**单独放一行**指令:

```
[[send-image: C:\绝对路径\图片.png]]
[[send-video: C:\绝对路径\视频.mp4]]
[[send-file:  C:\绝对路径\文件.zip]]
```

桥接会:截获这些指令行 → 依次上传到微信 CDN(密文, AES-128-ECB) → 作为真实媒体消息发出;其余文字正常发出(先文字、后媒体)。指令行本身不会发给用户。

> 需要让 Codex 知道有这条能力——本仓库的 [AGENTS.md](./AGENTS.md) 已写好说明;记得按你的需求定制。

## iLink 接口速查

完整协议见 openclaw-weixin 插件 README 的"后端 API 协议"一节。本项目用到:

| 端点 | 用途 |
|---|---|
| `POST ilink/bot/getupdates` | 长轮询收消息(`{get_updates_buf}` → `{msgs, get_updates_buf}`) |
| `POST ilink/bot/sendmessage` | 发消息(`item_list` 里 `type` 决定文本/图片/视频/文件) |
| `POST ilink/bot/getconfig` / `sendtyping` | "正在输入"状态 |
| `POST ilink/bot/msg/notifystart` / `notifystop` | 上下线通知 |
| `POST ilink/bot/getuploadurl` | 上传前取上传地址(发图/视频/文件) |
| `GET/POST https://novac2c.cdn.weixin.qq.com/c2c/...` | CDN 下载 / 上传(密文) |

公共请求头:`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <token>`、`X-WECHAT-UIN`、`iLink-App-Id: bot`。每条出站消息必须回传该会话最近一次收到的 `context_token`。

### 两个写进代码的坑

1. **sendmessage 必须带全字段**:`msg` 里除了 `to_user_id` / `context_token` / `item_list`,还要带 `from_user_id: ""`、`client_id`、`message_type: 2`(BOT)、`message_state: 2`(FINISH)、`run_id`。少字段时后端会假确认(`ret=0`)但**消息不投递**——日志显示 replied、用户却收不到。
2. **AES key 两种编码**:图片的 `media.aes_key` 可能是 base64(16 字节原始 key),文件/语音/视频则常见 base64(32 字符 hex 串),解密前要按解码后长度区分(16 → 直接用;32 且全 hex → 再按 hex 解析)。

## 附带的脚本

| 脚本 | 用途 |
|---|---|
| `weixin-codex.mjs` | 主桥接程序(常驻) |
| `send-image.mjs` | 主动给微信用户发一张本地图片(`node send-image.mjs <图片路径>`) |
| `send-video.mjs` | 主动发本地视频/文件(`node send-video.mjs [--as-file] <路径>`) |
| `recover.mjs` | 一次性补救:把一张已保存的入站图片重新转录并让 Codex 回复 |
| `directives.mjs` | 主脚本与文档共用的媒体指令解析(`[[send-*: ...]]`) |
| `run-client.cmd` / `run-client-hidden.vbs` | Windows 隐藏窗口启动器 |

开发:运行单元测试 `npm test`(Node 内置 test runner,零依赖)。

## 开机自启

### Windows(计划任务,推荐)

计划任务托管而非普通子进程,可避免父进程重启时被连带杀死:

```powershell
$dir = "C:\path\to\weixin-codex"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$dir\run-client-hidden.vbs`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT30S"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Weixin Codex Client" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
```

### Linux(systemd,示例)

```ini
# /etc/systemd/user/weixin-codex.service
[Unit]
Description=Weixin <-> Codex bridge
After=network-online.target

[Service]
WorkingDirectory=/home/<user>/weixin-codex
ExecStart=/usr/bin/node weixin-codex.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now weixin-codex
```

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `poll got 1 msg(s)` 后无下文 | 消息被过滤(`message_type===2` 是 bot 回声,正常);或账号被其他客户端抢收 |
| 微信收到"（桥接出错,稍后重试）" | Codex CLI 不可用/spawn 失败;检查 `codexNode` / `codexCli` |
| 微信收到"（Codex 处理完成,但没有文字回复…）" | Codex 这一轮失败或超时。日志若有 `rotating to a fresh thread` 说明会话过大,已自动换新线程;否则看 `waitMs` 是否太小 |
| 日志 `codex turn failed … rotating to a fresh thread` | 续用的会话过大(常见报错 `413 Payload Too Large`),程序已自动改用新线程重试;属正常自愈 |
| 一条消息两个回复 | OpenClaw 微信通道没停用(见快速开始第 2 步) |
| `STALE TOKEN (-14)` | 登录 token 过期:重新启用插件 → `openclaw channels login --channel openclaw-weixin` 扫码 → 再停用 → 重启本客户端 |
| 日志显示 replied 但微信收不到 | sendmessage 报文缺字段被假确认——用本仓库最新版脚本(见"两个坑") |
| 发图收到"图片识别暂时不可用" | 未设置 `DEEPSEEK_API_KEY`,或视觉模型接口报错/限流 |
| 会话文件很大、回复变慢 | Codex 会话线程会随对话增长;程序会在失败时自动换新线程。也可手动删除 `state/codex-session.json` 里的 `threadId` 让它重开 |

## 安全

- accounts 目录里的 token 相当于你的微信机器人身份凭证:**绝不提交到仓库**;泄露后立即重新扫码轮换
- 本仓库已通过 `.gitignore` 排除 `config.json`、`state/`、日志与备份
- Codex CLI 以 `--dangerously-bypass-approvals-and-sandbox` 运行 → 微信消息会以你的本机权限执行。请只在可信账号下使用
- 详见 [SECURITY.md](./SECURITY.md)

## 限制与 TODO

- [ ] 语音(带 ASR 文本的语音已能走文字通道;无 ASR 的 SILK 需转码)
- [ ] 群聊消息(目前只处理私聊)
- [ ] 多账号同时在线
- [ ] 会话自动轮换/压缩策略的可配置化

## 免责声明

- 本项目使用**非官方、未公开声明**的微信 iLink Bot 接口,可能随腾讯后端变更而失效。请自行评估账号风险。
- 本项目与腾讯、微信、OpenAI 均无关联,不代表其官方立场。
- 请在遵守当地法律法规与平台服务条款的前提下,仅用于**你自己的账号**、自托管场景。

## 许可证

[MIT](./LICENSE)
