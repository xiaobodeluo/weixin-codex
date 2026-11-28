import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function getConfigPath() {
  return process.env.WEIXIN_CONFIG || path.join(SCRIPT_DIR, "config.json");
}

export function resolveFromScript(value = "") {
  return value ? path.resolve(SCRIPT_DIR, String(value)) : "";
}

export function loadConfig() {
  const file = getConfigPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`cannot read config.json: ${String(err)}`);
  }
}

export function extractOption(argv, name) {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index < 0) return "";
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  argv.splice(index, 2);
  return value;
}

export function maskIdentifier(value) {
  const text = String(value || "");
  if (!text) return "none";
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

export function resolveWeixinAccount({ target = "" } = {}) {
  const config = loadConfig();
  const accountDir =
    resolveFromScript(process.env.WEIXIN_ACCOUNT_DIR || config.accountDir) ||
    path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
  const accountId = process.env.WEIXIN_ACCOUNT_ID || config.accountId || "";
  if (!accountId || accountId === "REPLACE_WITH_YOUR_ACCOUNT_ID") {
    throw new Error(
      "accountId is required (config.json accountId or WEIXIN_ACCOUNT_ID)",
    );
  }

  const accountFile = path.join(accountDir, `${accountId}.json`);
  if (!fs.existsSync(accountFile)) {
    throw new Error(`account file not found: ${accountFile}`);
  }
  const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
  if (!account.token) throw new Error("account file has no token");
  if (!account.baseUrl) throw new Error("account file has no baseUrl");

  const tokensFile = path.join(accountDir, `${accountId}.context-tokens.json`);
  const contextTokens = fs.existsSync(tokensFile)
    ? JSON.parse(fs.readFileSync(tokensFile, "utf-8"))
    : {};
  const to =
    target ||
    process.env.WEIXIN_TO ||
    Object.keys(contextTokens)[0] ||
    account.userId ||
    "";
  if (!to) throw new Error("no target user; pass --to <id> after receiving a message once");

  return {
    config,
    accountDir,
    accountId,
    accountFile,
    account,
    contextTokens,
    to,
    contextToken: contextTokens[to] || "",
  };
}
