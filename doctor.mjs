#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  getConfigPath,
  loadConfig,
  resolveFromScript,
  resolveWeixinAccount,
  SCRIPT_DIR,
  maskIdentifier,
} from "./weixin-account.mjs";

const checks = [];
const add = (ok, label, detail = "") => checks.push({ ok, label, detail });

add(
  Number(process.versions.node.split(".")[0]) >= 22,
  "Node.js >= 22",
  process.versions.node,
);

const configPath = getConfigPath();
add(fs.existsSync(configPath), "config.json", configPath);

let session;
try {
  const config = loadConfig();
  session = resolveWeixinAccount();
  add(Boolean(session.accountId), "accountId", maskIdentifier(session.accountId));
  add(true, "account credentials", session.accountDir);
  add(Object.keys(session.contextTokens).length > 0, "context tokens", "received at least one WeChat message");

  const stateDir =
    resolveFromScript(process.env.WEIXIN_STATE_DIR || config.stateDir) ||
    path.join(path.dirname(configPath), "state");
  add(Boolean(stateDir), "state directory", stateDir);

  const node = config.codexNode || "node";
  const cli = config.codexCli || "";
  const args = cli ? [cli, "--version"] : ["--version"];
  const version = spawnSync(node, args, {
    encoding: "utf-8",
    timeout: 10000,
    shell: process.platform === "win32" && !cli,
  });
  add(
    version.status === 0,
    "Codex CLI",
    String(version.stdout || version.stderr || version.error || "").trim(),
  );
} catch (err) {
  add(false, "bridge configuration", String(err.message || err));
}

const silk = path.join(SCRIPT_DIR, "vendor", "silk-wasm", "lib", "silk.wasm");
add(fs.existsSync(silk), "bundled silk-wasm", silk);

for (const check of checks) {
  console.log(`${check.ok ? "OK  " : "FAIL"} ${check.label}${check.detail ? `: ${check.detail}` : ""}`);
}

if (checks.some((check) => !check.ok)) process.exit(1);
