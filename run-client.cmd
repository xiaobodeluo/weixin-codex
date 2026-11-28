@echo off
REM Portable Windows launcher. Keep this file ASCII-only.
cd /d "%~dp0"
node weixin-codex.mjs >> client.log 2>> client.err.log
