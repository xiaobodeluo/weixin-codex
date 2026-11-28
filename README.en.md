# weixin-codex

A self-hosted WeChat bridge for the local Codex app-server and CLI. The default
mode keeps one Codex app-server thread and steers new WeChat messages into the
active turn, so you can keep talking while work is running.

> Version `0.3.0`. Chinese documentation: [README.md](./README.md).

This is not an official Tencent, WeChat, or OpenAI product. It relies on an
undocumented WeChat iLink Bot API that can change without notice.

## Features

- Persistent Codex app-server thread with `turn/steer`
- Manager/worker fallback queue when app-server is unavailable
- Non-blocking WeChat long polling
- Text, image, video, and file messages
- Standalone WeChat channel CLI
- Optional image transcription and Breeze TTS voice replies
- No third-party runtime dependencies
- Sanitized logs and repository-level configuration

## Requirements

- Node.js 22+
- Installed and authenticated Codex CLI
- OpenClaw with `openclaw-weixin` logged in once
- Optional OpenAI-compatible vision endpoint
- Optional Breeze TTS service

## Quick start

```bash
git clone https://github.com/xiaobodeluo/weixin-codex.git
cd weixin-codex

npm install -g openclaw
npx -y @tencent-weixin/openclaw-weixin-cli@latest install

openclaw config set plugins.entries.openclaw-weixin.enabled false
openclaw gateway restart

cp config.example.json config.json
npm run doctor
npm start
```

Set `accountId` in `config.json`. The default `codexNode: "codex"` invokes the
native Codex command. For a Node-wrapped installation:

```json
{
  "codexNode": "node",
  "codexCli": "C:/path/to/node_modules/@openai/codex/bin/codex.js"
}
```

Windows can use `run-client-hidden.vbs`; logs are written to `client.log` and
`client.err.log`.

## Channel CLI

```bash
node wechat-channel.mjs contacts
node wechat-channel.mjs poll --seconds 10
node wechat-channel.mjs send --text "hello"
node wechat-channel.mjs send-media --path "C:/absolute/report.pdf" --kind file
```

Every command writes one JSON object to stdout. Do not run multiple consumers
for the same WeChat account at the same time.

## Media directives

Put one directive on its own line in the final Codex response:

```text
[[send-image: C:\absolute\picture.png]]
[[send-video: C:\absolute\clip.mp4]]
[[send-file: C:\absolute\document.pdf]]
```

The bridge removes the directive, sends the remaining text, and uploads each
file as a real WeChat media message.

## Tests

```bash
npm test
```

CI runs on Node.js 22 and 24.

## Security

Incoming WeChat messages are effectively a remote command entry point. By
default Codex receives full local tool access. Only connect a trusted account,
never publish `config.json`, account credentials, logs, or `state/`, and rotate
the login immediately if a token leaks. See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE). The bundled `vendor/silk-wasm` retains its own MIT license.
