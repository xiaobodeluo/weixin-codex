# weixin-codex

Bridge your WeChat messages straight into a local **Codex CLI** session: messages you send in WeChat go to a Codex session, and Codex's replies are sent back to WeChat.

> Self-hosted, lightweight WeChat ⇄ AI bridge. It does **not** go through OpenClaw's agent runtime — it only reuses the login credentials produced by the `openclaw-weixin` plugin and talks to the WeChat iLink Bot backend directly (`getupdates` long-poll + `sendmessage`), using your local Codex CLI as the "brain".

> [中文文档](./README.md)

## Features

- WeChat ⇄ Codex direct connection: same machine, same Codex config, same tools
- Text messages, with a "typing…" indicator
- **Images**: download+decrypt from the WeChat CDN → transcribe with a vision model → feed the transcript to Codex
- **Codex can send media back**: one directive line in the reply sends a local image/video/file to WeChat
- Message dedup and a persisted sync cursor (no loss, no replay after restart)
- Self-healing: clear error messages on failure, and automatic rotation to a fresh thread when a resumed thread has grown too large (e.g. HTTP 413)
- Zero third-party dependencies (Node built-ins only)

## Architecture

```
WeChat user
   │  (1) send message
   ▼
Tencent iLink Bot backend (ilinkai.weixin.qq.com)
   │  (2) long-poll getupdates (with local login token)
   ▼
weixin-codex.mjs (this repo, long-running)
   │  (3) spawn `codex exec …`
   ▼
Codex CLI session
   │  (4) parse the --json event stream, extract the final reply text
   ▼
weixin-codex.mjs
   │  (5) sendmessage (with context_token)
   ▼
WeChat user receives the reply
```

## Prerequisites

- **Node.js ≥ 22** (uses global `fetch`)
- **Codex CLI** installed and logged in
- **OpenClaw + the openclaw-weixin plugin**, scanned/logged in at least once (used only as a "login helper")
- For image features: any OpenAI-compatible vision model (defaults to DeepSeek `deepseek-v4-flash-vision-exp`)

## Quick start

```bash
# 1. Install OpenClaw + WeChat plugin and scan the QR code
npm install -g openclaw
npx -y @tencent-weixin/openclaw-weixin-cli@latest install

# 2. Disable OpenClaw's own WeChat channel (important — avoids double replies)
openclaw config set plugins.entries.openclaw-weixin.enabled false
openclaw gateway restart

# 3. Clone, configure, run
git clone <your-repo> weixin-codex
cd weixin-codex
cp config.example.json config.json   # set "accountId" and your Codex CLI path
node weixin-codex.mjs
```

See the [Chinese README](./README.md) for the full walkthrough (config reference, iLink protocol notes, two gotchas that will bite you, Windows/systemd autostart, troubleshooting).

## Sending media from Codex

Put a directive on its own line in the reply:

```
[[send-image: C:\abs\path.png]]
[[send-video: C:\abs\path.mp4]]
[[send-file:  C:\abs\path.zip]]
```

The bridge strips these lines, uploads each file to the WeChat CDN (AES-128-ECB), and sends it as a real media message; the remaining text is sent as the chat reply.

## Security

- Tokens in `~/.openclaw/openclaw-weixin/accounts/` are your bot's identity — **never commit them**. Rotate by re-scanning if leaked.
- Codex runs with `--dangerously-bypass-approvals-and-sandbox`, so WeChat messages execute with your local privileges. Only use with accounts you fully trust.
- See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)

## Disclaimer

Uses an unofficial, undocumented WeChat iLink Bot API that may change without notice. Not affiliated with Tencent/WeChat or OpenAI. Use at your own risk, on your own account only.
