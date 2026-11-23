# weixin-codex

A self-hosted WeChat bridge for the local Codex CLI. WeChat talks to a persistent **manager** session while independent **worker** sessions perform the actual work, so chat remains responsive while jobs run.

> [Chinese documentation](./README.md)

## What changed in v0.2.0

- Persistent manager session for conversation, routing and summaries
- Independent Codex worker for every dispatched task
- Concurrent jobs (2 by default)
- Non-blocking WeChat long poll
- Periodic progress messages, cancellation and process-tree termination
- Persisted job queue in `state/jobs.json`
- Image transcription, optional Breeze TTS and outbound media directives
- Structured manager decisions validated by a JSON schema

## Architecture

```text
WeChat user
   │
   ▼
Tencent iLink Bot backend
   │ getupdates long poll
   ▼
weixin-codex.mjs
   ├── manager queue ──> persistent Codex manager
   │                       │ reply / dispatch / cancel
   │                       ▼
   └───────────────────> worker queue
                           ├── worker #1
                           └── worker #2
                                 │ job_finished
                                 ▼
                       manager summarizes to WeChat
```

## Prerequisites

- Node.js 22+
- An installed and authenticated Codex CLI
- OpenClaw plus `openclaw-weixin`, logged in once
- Optional: an OpenAI-compatible vision model for image transcription
- Optional: Breeze TTS and the bundled `vendor/silk-wasm`

## Quick start

```bash
# Login helper
npm install -g openclaw
npx -y @tencent-weixin/openclaw-weixin-cli@latest install

# Disable OpenClaw's own WeChat channel to avoid duplicate consumers
openclaw config set plugins.entries.openclaw-weixin.enabled false
openclaw gateway restart

# Configure and run
cp config.example.json config.json
node weixin-codex.mjs
```

Set `accountId` and point `codexNode` / `codexCli` at the local Codex CLI. See the Chinese README for the complete configuration reference and setup details.

## Tests

```bash
npm test
```

The tests cover media directive parsing and structured manager decisions.

## Sending media

Put a directive on its own line:

```text
[[send-image: C:\abs\path.png]]
[[send-video: C:\abs\path.mp4]]
[[send-file:  C:\abs\path.zip]]
```

The bridge strips the directive, uploads the local file to the WeChat CDN and sends it as a real media message.

## Security

Never commit `config.json`, WeChat tokens, context tokens, API keys, logs or `state/`. Workers inherit the local Codex tool permissions and may modify this machine. Only connect a trusted WeChat account.

This project uses an unofficial iLink Bot API and is not affiliated with Tencent, WeChat or OpenAI.

## License

[MIT](./LICENSE)
