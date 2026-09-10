@echo off
REM WeChat <-> Codex bridge launcher.
REM ASCII-only on purpose: cmd parses batch files in the system ANSI codepage,
REM so hardcoded non-ASCII paths would be mangled.
REM
REM Replace `node` below with a full path (e.g. "C:\Program Files\nodejs\node.exe")
REM if Node is not on PATH.
cd /d "%~dp0"
node weixin-codex.mjs >> client.log 2>> client.err.log
