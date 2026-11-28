# Changelog

## 0.3.0 - 2026-11-28

- Add the Codex app-server engine with persistent thread resume and
  `turn/steer`.
- Keep the manager/worker queue as an automatic fallback.
- Add the WeChat channel CLI (`contacts`, `poll`, `send`, `send-media`).
- Add standalone text sending and generalized image/video/file tools.
- Read account and path settings from `config.json` or environment variables.
- Add `--to` targeting, repository-relative config paths, and privacy-safe logs.
- Add `doctor`, syntax/JSON checks, account helper tests, and a Node 22/24 CI
  matrix.
- Remove hard-coded account IDs, personal paths, runtime state, screenshots,
  logs, and unrelated local scripts from the public release.

## 0.2.0 - 2026-11-23

- Introduce persistent manager sessions and independent worker jobs.
- Add concurrent jobs, progress messages, cancellation, and persisted results.
- Add image transcription, Breeze TTS, and outbound media directives.

## 0.1.0 - 2026-09-10

- Initial WeChat-to-Codex CLI bridge with text, images, and agent-sent media.
