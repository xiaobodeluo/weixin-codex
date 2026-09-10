#!/usr/bin/env node
// Send a local image file to the WeChat user via the iLink bot protocol.
// Reuses the same account credentials as weixin-codex.mjs.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "config.json"), "utf-8"));
  } catch {
    return {};
  }
})();

const ACCOUNT_DIR =
  CFG.accountDir || path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
const ACCOUNT_ID = CFG.accountId || process.env.WEIXIN_ACCOUNT_ID || "";
if (!ACCOUNT_ID) {
  console.error("accountId is required (config.json accountId or WEIXIN_ACCOUNT_ID)");
  process.exit(2);
}
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

const accountFile = path.join(ACCOUNT_DIR, `${ACCOUNT_ID}.json`);
const tokensFile = path.join(ACCOUNT_DIR, `${ACCOUNT_ID}.context-tokens.json`);

const rawKey = process.argv.includes("--raw-key");
const imagePath = process.argv
  .slice(2)
  .find((arg) => arg !== "--raw-key");
if (!imagePath || !fs.existsSync(imagePath)) {
  console.error("usage: node send-image.mjs [--raw-key] <image path>");
  process.exit(2);
}

const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
const contextTokens = fs.existsSync(tokensFile)
  ? JSON.parse(fs.readFileSync(tokensFile, "utf-8"))
  : {};

const to = Object.keys(contextTokens)[0] || account.userId;
const ctxToken = contextTokens[to] || "";
const { token, baseUrl } = account;
const masked = token ? `${token.slice(0, 6)}...${token.slice(-4)}` : "NONE";

const redact = (s) => String(s).replaceAll(token || "___", "***TOKEN***");

function randomUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function headers() {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(
      ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff),
    ),
  };
}

const baseInfo = { channel_version: "2.4.6", bot_agent: "Codex/1.0" };

async function wxPost(endpoint, body, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(
        `wx ${endpoint} HTTP ${res.status}: ${redact(raw).slice(0, 400)}`,
      );
    }
    return JSON.parse(raw);
  } finally {
    clearTimeout(t);
  }
}

const aesEcbPaddedSize = (plainSize) =>
  Math.ceil((plainSize + 1) / 16) * 16;

async function main() {
  console.log(`image: ${imagePath}`);
  console.log(`to: ${to}`);
  console.log(`token: ${masked}`);

  const plaintext = fs.readFileSync(imagePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  console.log(`size: ${rawsize} bytes, ciphertext: ${filesize} bytes`);

  const uploadUrlResp = await wxPost("ilink/bot/getuploadurl", {
    filekey,
    media_type: 1, // IMAGE
    to_user_id: to,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
    base_info: baseInfo,
  });

  if (uploadUrlResp.ret && uploadUrlResp.ret !== 0) {
    throw new Error(
      `getuploadurl ret=${uploadUrlResp.ret} errmsg=${uploadUrlResp.errmsg ?? "(none)"}`,
    );
  }

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error("getuploadurl returned no upload URL");
  }

  const cdnUrl = uploadFullUrl
    ? uploadFullUrl
    : `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(
        uploadParam,
      )}&filekey=${encodeURIComponent(filekey)}`;

  const cipher = crypto.createCipheriv("aes-128-ecb", aeskey, null);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  let downloadParam;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status !== 200) {
        const msg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN HTTP ${res.status}: ${redact(msg).slice(0, 300)}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN response missing x-encrypted-param header");
      }
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error("CDN upload failed after 3 attempts");
  }

  console.log("CDN upload done");

  const clientId = `weixin-codex:${Date.now()}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  const media = {
    encrypt_query_param: downloadParam,
    // The working image variant is base64(hex string), same as file/video.
    // --raw-key switches to base64(raw 16 bytes), which WeChat dropped here.
    aes_key: rawKey
      ? Buffer.from(aeskey).toString("base64")
      : Buffer.from(aeskey.toString("hex"), "ascii").toString("base64"),
    encrypt_type: 1,
  };
  const item = {
    type: 2, // IMAGE
    image_item: {
      media,
      mid_size: ciphertext.length,
    },
  };
  const resp = await wxPost("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [item],
      context_token: ctxToken,
      run_id: `codex-${crypto.randomUUID()}`,
    },
    base_info: baseInfo,
  });

  if (resp.ret && resp.ret !== 0) {
    throw new Error(
      `sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`,
    );
  }

  console.log(`sent clientId=${clientId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${redact(err?.message ?? String(err))}`);
  process.exit(1);
});
