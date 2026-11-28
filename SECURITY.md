# 安全说明

## 远程执行边界

微信消息会进入本机 Codex。默认 app-server 和 worker 使用完整工具权限，
因此能读写文件、执行命令、访问网络和操作本机软件。请把微信账号视为一个
远程执行入口。

建议：

- 只连接你完全信任的微信账号。
- 在专用目录、专用机器或隔离环境中运行。
- 定期检查 `state/jobs.json`、任务输出和日志。
- 不使用时停止桥接进程。

## 凭证和敏感文件

- 微信 token 位于 `~/.openclaw/openclaw-weixin/accounts/`，相当于机器人
  身份凭证，泄露后应立即重新扫码登录。
- 视觉或 manager API key 可来自环境变量 `DEEPSEEK_API_KEY` 或本机
  `~/.dsh/.credentials.yaml`。
- Codex 自己的模型凭证由本机 Codex 管理。
- `.gitignore` 排除 `config.json`、`state/`、`outputs/`、`work/`、日志和
  备份文件。
- 发布 issue、截图或日志前，先删除账号 ID、联系人 ID、context token、
  API key 和本机路径。

源码不会打印 token，运行时日志会对账号和联系人 ID 做掩码。

## 对外网络面

桥接进程只主动调用微信 iLink Bot 后端、微信 CDN 和可选的视觉/TTS 服务。
它不监听公网端口。微信频道 CLI 同样只发起出站请求。

## 第三方协议

项目使用未公开的微信 iLink Bot 协议，与腾讯或微信没有隶属或授权关系。
协议变化可能导致登录、收消息或媒体发送失效。项目负责人不对账号限制、
协议变更造成的数据丢失或服务中断作保证。

## 报告问题

发现安全问题时，请优先使用 GitHub 仓库的私密漏洞报告功能，或通过维护者
的 GitHub 主页私下联系。不要在公开 issue 中粘贴 token、账号文件和运行
日志。
