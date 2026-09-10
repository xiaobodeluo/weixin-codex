# 安全说明

## 凭证与密钥

- `~/.openclaw/openclaw-weixin/accounts/` 里的 token 相当于你的微信机器人身份凭证。**绝不要提交到仓库**,泄露后请立即重新扫码登录轮换。
- 本仓库源码**不包含**任何 token / API Key。所有凭证都在运行时从以下位置读取:
  - 微信 token: `~/.openclaw/openclaw-weixin/accounts/<ACCOUNT_ID>.json`
  - 视觉模型 key: 环境变量 `DEEPSEEK_API_KEY`,或 `~/.dsh/.credentials.yaml`
  - Codex 自身的模型凭证: 由本机 Codex CLI 管理(如 `~/.codex/`)
- `.gitignore` 已排除 `config.json`、`state/`、`outputs/`、日志与备份文件。

## 攻击面

- 本程序**只**监听微信(iLink)后端,对外不开放端口。
- Codex CLI 以 `--dangerously-bypass-approvals-and-sandbox` 运行,即微信发来的指令会以你的本机权限执行。请仅在你完全信任的微信号/账号下使用,并优先在隔离环境或专用账号中运行。
- 传入的消息会进入 Codex 会话,请像对待"远程执行入口"一样对待它。

## 上报问题

如果你发现安全问题,请不要公开提交 issue,先私下联系维护者。
