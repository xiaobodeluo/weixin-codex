#!/usr/bin/env node
// WeChat <-> Codex bridge.
// Transport: WeChat iLink Bot backend (getupdates long-poll + sendmessage),
// reusing the openclaw-weixin account credentials (same as dsh-weixin-direct).
// Brain: the local Codex CLI (`codex exec`, same model/permissions as the
// desktop app). A persistent manager session talks to WeChat and dispatches
// work to independent worker sessions, so conversation does not block or
// interrupt execution. Images are transcribed by the DeepSeek multimodal
// (vision) model first, then the transcript is passed to the manager.
// When Breeze TTS is enabled, short Codex replies are returned as WeChat voice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createDecipheriv } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sendBreezeVoiceReply } from "./breeze-voice.mjs";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import { extractMediaDirectives } from "./directives.mjs";
import { requestManagerDecision, resolveManagerApi } from "./manager-api.mjs";
import { parseManagerDecision } from "./manager-protocol.mjs";
import {
  maskIdentifier,
  resolveFromScript,
} from "./weixin-account.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const file = process.env.WEIXIN_CONFIG || path.join(SCRIPT_DIR, "config.json");
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (err) {
      console.error("config.json parse failed:", String(err));
    }
  }
  return {};
}

const CFG = loadConfig();
const MANAGER_API = resolveManagerApi(CFG);
const AGENT_ENGINE = String(CFG.engine || "app-server").toLowerCase();
const AGENT_EFFORT = String(CFG.agentEffort || "high").toLowerCase();

const ACCOUNT_DIR =
  resolveFromScript(process.env.WEIXIN_ACCOUNT_DIR || CFG.accountDir) ||
  path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
const ACCOUNT_ID = process.env.WEIXIN_ACCOUNT_ID || CFG.accountId || "";
if (!ACCOUNT_ID) {
  console.error("accountId is required (config.json accountId or WEIXIN_ACCOUNT_ID)");
  process.exit(2);
}

const STATE_DIR =
  resolveFromScript(process.env.WEIXIN_STATE_DIR || CFG.stateDir) ||
  path.join(SCRIPT_DIR, "state");
const WORKSPACE_DIR = resolveFromScript(CFG.workspaceDir) || SCRIPT_DIR;
const JOB_WAIT_MS = Number.isFinite(CFG.waitMs) ? CFG.waitMs : 600000;
const MANAGER_WAIT_MS = Number.isFinite(CFG.managerWaitMs)
  ? Math.max(30000, CFG.managerWaitMs)
  : 120000;
const JOB_CONCURRENCY = Number.isFinite(CFG.jobConcurrency)
  ? Math.max(1, Math.min(4, CFG.jobConcurrency))
  : 2;
const JOB_PROGRESS_MS = Number.isFinite(CFG.jobProgressMs)
  ? Math.max(30000, CFG.jobProgressMs)
  : 120000;
const MESSAGE_BATCH_MS = Number.isFinite(CFG.messageBatchMs)
  ? Math.max(500, CFG.messageBatchMs)
  : 1500;
const IMAGE_BATCH_MS = Number.isFinite(CFG.imageBatchMs)
  ? Math.max(1000, CFG.imageBatchMs)
  : 5000;
const MEDIA_DEDUPE_MS = Number.isFinite(CFG.mediaDedupeMs)
  ? Math.max(10000, CFG.mediaDedupeMs)
  : 900000;
const BREEZE_TTS = CFG.breezeTts && typeof CFG.breezeTts === "object"
  ? {
      ...CFG.breezeTts,
      channelVersion: CFG.breezeTts.channelVersion || "2.4.6",
      botAgent: CFG.breezeTts.botAgent || "Codex/1.0",
    }
  : { enabled: false };

const VISION_BASE = CFG.visionBaseUrl || "https://api.deepseek.com";
const VISION_MODEL = CFG.visionModel || "deepseek-v4-flash-vision-exp";
const VISION_MAX_TOKENS = Number.isFinite(CFG.visionMaxTokens) ? CFG.visionMaxTokens : 1024;
const VISION_TIMEOUT_MS = Number.isFinite(CFG.visionTimeoutMs)
  ? Math.max(5000, CFG.visionTimeoutMs)
  : 20000;
const VISION_ATTEMPTS = Number.isFinite(CFG.visionAttempts)
  ? Math.min(5, Math.max(1, CFG.visionAttempts))
  : 2;
const VISION_MODELS =
  Array.isArray(CFG.visionModels) && CFG.visionModels.length
    ? CFG.visionModels
    : [VISION_MODEL];
function loadVisionKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".dsh", ".credentials.yaml"), "utf-8");
    const m = raw.match(/^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}
const VISION_API_KEY = loadVisionKey();

const CODEX_NODE = CFG.codexNode || "codex";
const CODEX_CLI = CFG.codexCli || "";
const CODEX_RETRY_MS = Number.isFinite(CFG.codexRetryMs)
  ? Math.max(500, CFG.codexRetryMs)
  : 2000;

const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.4.6";
const CLIENT_VERSION = String(((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff));
const BOT_AGENT = "Codex/1.0";
const LONG_POLL_TIMEOUT_MS = 40000;
const API_TIMEOUT_MS = 15000;
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_REPLY_CHUNK = 1900;

const log = (level, ...args) =>
  console.log(`[${new Date().toISOString()}] [${level}]`, ...args);

fs.mkdirSync(STATE_DIR, { recursive: true });
const seenFile = path.join(STATE_DIR, "seen-ids.json");
const managerSessionFile = path.join(STATE_DIR, "codex-manager-session.json");
const managerHistoryFile = path.join(STATE_DIR, "manager-history.json");
const appThreadFile = path.join(STATE_DIR, "codex-app-thread.json");
const managerReplyFile = path.join(STATE_DIR, "manager-reply.txt");
const jobsFile = path.join(STATE_DIR, "jobs.json");
const managerSchemaFile = path.join(SCRIPT_DIR, "manager-response.schema.json");
const imagesDir = path.join(STATE_DIR, "images");
const voiceDir = path.join(STATE_DIR, "voice");
const jobRepliesDir = path.join(STATE_DIR, "job-replies");
fs.mkdirSync(imagesDir, { recursive: true });
fs.mkdirSync(voiceDir, { recursive: true });
fs.mkdirSync(jobRepliesDir, { recursive: true });

let APP_CLIENT = null;
let appLastFrom = "";

async function handleAppFinal(result) {
  const from = appLastFrom || userId;
  if (!from) return;
  const text =
    result.text ||
    (result.status === "failed"
      ? `这次任务失败了：${String(result.error || "未知错误").slice(0, 1000)}`
      : "");
  if (!text) {
    log("warn", `app-server turn produced no final text status=${result.status}`);
  } else {
    await deliverLeaderReply(from, text);
  }
  await sendTyping(from, contextTokens[from] ?? "", 2);
}

async function startAppServer() {
  if (AGENT_ENGINE === "manager") return false;
  try {
    APP_CLIENT = new CodexAppServerClient({
      node: CODEX_NODE,
      cli: CODEX_CLI,
      workspace: WORKSPACE_DIR,
      threadFile: appThreadFile,
      effort: AGENT_EFFORT,
      baseInstructions: [
        "你是用户微信里的连续 Codex 助手。",
        "直接完成当前请求，用简短自然的中文回复。",
        "用户在任务运行中发来的新消息应作为同一任务的 steering 立即吸收。",
        "只有在确实有助于推进时才使用子智能体；不要为了形式拆分任务。",
      ].join("\n"),
      onFinal: handleAppFinal,
      onProgress: (text) => log("info", `app progress len=${text.length}`),
      onError: (text) => log("warn", "app-server", text),
    });
    const info = await APP_CLIENT.start();
    log("info", `agent engine=app-server thread=${info.threadId} effort=${AGENT_EFFORT}`);
    return true;
  } catch (err) {
    log("warn", "app-server unavailable, falling back to manager", String(err));
    try {
      APP_CLIENT?.stop();
    } catch {}
    APP_CLIENT = null;
    return false;
  }
}

const seenIds = new Set(
  fs.existsSync(seenFile) ? JSON.parse(fs.readFileSync(seenFile, "utf-8")) : [],
);
const saveSeen = () =>
  fs.writeFileSync(seenFile, JSON.stringify([...seenIds].slice(-2000)));

const accountFile = path.join(ACCOUNT_DIR, `${ACCOUNT_ID}.json`);
const syncFile = path.join(ACCOUNT_DIR, `${ACCOUNT_ID}.sync.json`);
const tokensFile = path.join(ACCOUNT_DIR, `${ACCOUNT_ID}.context-tokens.json`);

const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
const { token, baseUrl, userId } = account;

let syncBuf = "";
if (fs.existsSync(syncFile)) {
  try {
    syncBuf = JSON.parse(fs.readFileSync(syncFile, "utf-8")).get_updates_buf ?? "";
  } catch {}
}
const saveSyncBuf = () =>
  fs.writeFileSync(syncFile, JSON.stringify({ get_updates_buf: syncBuf }));

const contextTokens = fs.existsSync(tokensFile)
  ? JSON.parse(fs.readFileSync(tokensFile, "utf-8"))
  : {};
const saveContextTokens = () =>
  fs.writeFileSync(tokensFile, JSON.stringify(contextTokens));

let managerSessionId = "";
if (fs.existsSync(managerSessionFile)) {
  try {
    managerSessionId =
      JSON.parse(fs.readFileSync(managerSessionFile, "utf-8")).threadId || "";
  } catch {}
}
const saveManagerSession = (threadId) => {
  managerSessionId = threadId;
  fs.writeFileSync(managerSessionFile, JSON.stringify({ threadId }));
};

const MANAGER_HISTORY_LIMIT = Number.isFinite(CFG.managerHistoryMessages)
  ? Math.max(4, Math.min(40, CFG.managerHistoryMessages))
  : 12;
function normalizeManagerHistory(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && ["user", "assistant"].includes(item.role))
    .map((item) => ({
      role: item.role,
      content: String(item.content || "").slice(0, 8000),
    }))
    .filter((item) => item.content)
    .slice(-MANAGER_HISTORY_LIMIT);
}
let managerHistory = [];
if (fs.existsSync(managerHistoryFile)) {
  try {
    managerHistory = normalizeManagerHistory(
      JSON.parse(fs.readFileSync(managerHistoryFile, "utf-8")),
    );
  } catch {}
}
function saveManagerHistory(history) {
  managerHistory = normalizeManagerHistory(history);
  fs.writeFileSync(managerHistoryFile, JSON.stringify(managerHistory, null, 2));
}

// ------------------------------------------------------------------ weixin api
function wechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function headers() {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": wechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

async function wxPost(endpoint, body, timeoutMs = API_TIMEOUT_MS) {
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
    if (!res.ok) throw new Error(`wx ${endpoint} HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return JSON.parse(raw);
  } finally {
    clearTimeout(t);
  }
}

async function getUpdates() {
  try {
    return await wxPost(
      "ilink/bot/getupdates",
      { get_updates_buf: syncBuf, base_info: baseInfo() },
      LONG_POLL_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Normal long-poll expiry: nothing new this cycle.
      return { ret: 0, msgs: [], get_updates_buf: syncBuf };
    }
    throw err;
  }
}

async function sendMessage(to, ctxToken, text) {
  const clientId = `weixin-codex:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const resp = await wxPost("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text } }],
      context_token: ctxToken,
      run_id: `codex-${crypto.randomUUID()}`,
    },
    base_info: baseInfo(),
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
}

async function sendReply(to, ctxToken, text) {
  if (!text) return;
  if (text.length <= MAX_REPLY_CHUNK) {
    await sendMessage(to, ctxToken, text);
    return;
  }
  for (let i = 0; i < text.length; i += MAX_REPLY_CHUNK) {
    await sendMessage(to, ctxToken, text.slice(i, i + MAX_REPLY_CHUNK));
  }
}

const aesEcbPaddedSize = (plainSize) => Math.ceil((plainSize + 1) / 16) * 16;

async function sendMedia(to, ctxToken, filePath, kind) {
  if (!filePath || !fs.existsSync(filePath)) {
    log("warn", `sendMedia: file not found (${kind}) ${filePath}`);
    return;
  }
  // media_type: 1=IMAGE, 2=VIDEO, 3=FILE (per iLink getuploadurl)
  const mediaType = kind === "image" ? 1 : kind === "video" ? 2 : 3;
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const up = await wxPost("ilink/bot/getuploadurl", {
    filekey,
    media_type: mediaType,
    to_user_id: to,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
    base_info: baseInfo(),
  });
  if (up.ret && up.ret !== 0) {
    throw new Error(`getuploadurl ret=${up.ret} errmsg=${up.errmsg ?? "(none)"}`);
  }
  const uploadFullUrl = up.upload_full_url?.trim();
  const uploadParam = up.upload_param;
  if (!uploadFullUrl && !uploadParam) throw new Error("getuploadurl returned no upload URL");
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
        signal: AbortSignal.timeout(30000),
      });
      if (res.status !== 200) {
        const msg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN HTTP ${res.status}: ${String(msg).slice(0, 300)}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) throw new Error("CDN response missing x-encrypted-param header");
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error("CDN upload failed");
  }

  // WeChat expects base64(hex string) here for image/video/file alike.
  const media = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aeskey.toString("hex"), "ascii").toString("base64"),
    encrypt_type: 1,
  };
  const item =
    kind === "image"
      ? { type: 2, image_item: { media, mid_size: ciphertext.length } }
      : kind === "video"
        ? { type: 5, video_item: { media, video_size: ciphertext.length, play_length: 5 } }
        : {
            type: 4,
            file_item: { media, file_name: path.basename(filePath), len: String(rawsize) },
          };

  const clientId = `weixin-codex:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const resp = await wxPost("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [item],
      context_token: ctxToken,
      run_id: `codex-${crypto.randomUUID()}`,
    },
    base_info: baseInfo(),
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
  log("info", `sent ${kind} to=${to} name=${path.basename(filePath)} bytes=${rawsize}`);
}

async function sendTyping(to, ctxToken, status) {
  try {
    const cfg = await wxPost("ilink/bot/getconfig", {
      ilink_user_id: to,
      context_token: ctxToken,
      base_info: baseInfo(),
    });
    if ((cfg.ret && cfg.ret !== 0) || !cfg.typing_ticket) return;
    await wxPost("ilink/bot/sendtyping", {
      ilink_user_id: to,
      typing_ticket: cfg.typing_ticket,
      status,
      base_info: baseInfo(),
    });
  } catch (err) {
    log("warn", "sendTyping failed", String(err));
  }
}

async function notifyStart() {
  try {
    await wxPost("ilink/bot/msg/notifystart", { base_info: baseInfo() }, 10000);
  } catch (err) {
    log("warn", "notifyStart failed", String(err));
  }
}

async function notifyStop() {
  try {
    await wxPost("ilink/bot/msg/notifystop", { base_info: baseInfo() }, 10000);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------- message parsing
function bodyFromItemList(itemList) {
  if (!itemList || !itemList.length) return "";
  for (const item of itemList) {
    if (item.type === 1 && item.text_item && item.text_item.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && [2, 3, 4, 5].includes(ref.message_item.type)) return text;
      const parts = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
    if (item.type === 3 && item.voice_item && item.voice_item.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}

function itemTypes(itemList) {
  const out = { imageItems: [] };
  for (const item of Array.isArray(itemList) ? itemList : []) {
    if (item?.type === 2 && item?.image_item) out.imageItems.push(item);
  }
  return out;
}

// ------------------------------------------------------------------ images
function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  );
}

function imageMediaType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.toString("ascii", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (
    buf.length > 6 &&
    (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")
  )
    return "image/gif";
  return "";
}

async function downloadImage(item, label) {
  const img = item?.image_item;
  const qp = img?.media?.encrypt_query_param ?? "";
  const fullUrl = img?.media?.full_url ?? "";
  if (!qp && !fullUrl) throw new Error(`${label}: image item has no encrypt_query_param/full_url`);
  const url = fullUrl || `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(qp)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${label}: CDN download HTTP ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());
  const aesKeyBase64 = img.aeskey
    ? Buffer.from(img.aeskey, "hex").toString("base64")
    : img?.media?.aes_key ?? "";
  if (!aesKeyBase64) {
    return { buffer: encrypted, mediaType: imageMediaType(encrypted) || "image/jpeg" };
  }
  const key = parseAesKey(aesKeyBase64, label);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  const buffer = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const mediaType = imageMediaType(buffer);
  if (!mediaType) throw new Error(`${label}: decrypted ${buffer.length} bytes without a recognized image magic`);
  return { buffer, mediaType };
}

async function visionTranscribe(buffer, mediaType) {
  const dataUrl = `data:${mediaType};base64,${buffer.toString("base64")}`;
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "完整转录这张图片中的所有内容(文字、数字、表格逐行逐格),不要总结、不要评价、不要省略。直接输出转录文本。",
        },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  let lastErr;
  for (const model of VISION_MODELS) {
    for (let attempt = 0; attempt < VISION_ATTEMPTS; attempt++) {
      const body = { model, messages, max_tokens: VISION_MAX_TOKENS };
      try {
        const res = await fetch(`${VISION_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${VISION_API_KEY}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
        });
        if (res.status === 429) {
          lastErr = new Error(`${model} 429`);
          if (attempt + 1 < VISION_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 3000 + Math.floor(Math.random() * 1000)));
          }
          continue;
        }
        const raw = await res.text();
        if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${raw.slice(0, 300)}`);
        const j = JSON.parse(raw);
        const content = j?.choices?.[0]?.message?.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b) => b?.type === "text").map((b) => b.text).join("")
              : "";
        if (text && text.trim()) return { text: text.trim(), model };
        throw new Error(`${model} empty reply`);
      } catch (err) {
        lastErr = err;
        if (String(err?.message).includes("429")) {
          continue;
        }
        if (attempt + 1 < VISION_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
  }
  throw lastErr || new Error("DeepSeek vision failed");
}

// ------------------------------------------------------------------- codex
function killChildTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      try {
        child.kill();
      } catch {}
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {}
}

function codexArgs({ sessionId = "", outputFile, manager = false }) {
  const common = ["--skip-git-repo-check"];
  if (manager) {
    // The manager only talks and makes routing decisions. Keep it read-only so
    // a routing mistake cannot turn the foreground conversation into a worker.
    // `exec resume` does not expose --sandbox, so use the equivalent config key.
    if (sessionId) common.push("-c", 'sandbox_mode="read-only"');
    else common.push("--sandbox", "read-only");
    common.push("--output-schema", managerSchemaFile);
  } else {
    common.push("--dangerously-bypass-approvals-and-sandbox");
  }
  // The desktop config registers a `notify` hook that pings the desktop app on
  // every turn; silence it for WeChat turns to avoid notification spam.
  common.push("-c", "notify=[]");
  common.push("--json");
  common.push("-o", outputFile);
  if (sessionId) {
    return ["exec", "resume", ...common, sessionId, "-"];
  }
  return ["exec", "-C", WORKSPACE_DIR, ...common, "-"];
}

async function codexTurn(promptText, options = {}) {
  let sessionId = options.sessionId || "";
  const manager = Boolean(options.manager);
  const timeoutMs = options.timeoutMs || JOB_WAIT_MS;
  const outputFile = options.outputFile || managerReplyFile;

  const runOnce = async () => {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    const args = codexArgs({ sessionId, outputFile, manager });
    const env = { ...process.env };
    // These belong to the desktop-app thread that spawned us; strip them so the
    // child CLI manages its own session instead of targeting this one.
    delete env.CODEX_SESSION_ID;
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;

    const child = spawn(CODEX_NODE, CODEX_CLI ? [CODEX_CLI, ...args] : args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
      shell: process.platform === "win32" && !CODEX_CLI,
    });
    options.onChild?.(child);

    let lastAgentText = "";
    let newThreadId = "";
    let failed = false;
    let exitCode = null;
    let eventError = "";
    let stderrText = "";
    const handleLine = (line) => {
      const s = String(line).trim();
      if (!s.startsWith("{")) return;
      try {
        const ev = JSON.parse(s);
        if (ev.type === "thread.started" && ev.thread_id) newThreadId = ev.thread_id;
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
          if (typeof ev.item.text === "string" && ev.item.text.trim()) lastAgentText = ev.item.text;
        }
        // A hard failure (e.g. resume of an oversized thread -> HTTP 413) should
        // trigger a fresh-thread retry rather than silently returning no reply.
        if (ev.type === "error" || ev.type === "turn.failed") {
          failed = true;
          eventError =
            ev.message ||
            ev.error?.message ||
            ev.error ||
            ev.turn?.error?.message ||
            ev.turn?.error ||
            JSON.stringify(ev).slice(0, 1000);
        }
      } catch {
        // non-JSON line from the CLI; ignore
      }
    };

    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        handleLine(stdoutBuf.slice(0, idx));
        stdoutBuf = stdoutBuf.slice(idx + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrText = (stderrText + chunk.toString("utf8")).slice(-8000);
    });

    child.stdin.write(promptText + "\n");
    child.stdin.end();

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        log("warn", `${manager ? "manager" : "worker"} turn timed out, killing`);
        killChildTree(child);
        // Give the killed child a short window to flush, then move on.
        setTimeout(finish, 15000);
      }, timeoutMs);
      // `close` waits for inherited stdio pipes to close. A detached helper
      // (for example a stuck plugin marketplace git check) can keep those
      // handles open after Codex itself exits, so also settle on `exit`.
      child.on("exit", (code) => {
        exitCode = code ?? exitCode;
        clearTimeout(timer);
        setTimeout(finish, 250);
      });
      child.on("close", (code) => {
        exitCode = code ?? exitCode;
        clearTimeout(timer);
        finish();
      });
      child.on("error", (err) => {
        log("error", "codex spawn failed", String(err));
        exitCode = -1;
        clearTimeout(timer);
        finish();
      });
    });
    options.onChild?.(null);

    if (stdoutBuf.trim()) handleLine(stdoutBuf);

    let text = lastAgentText;
    if (!text && fs.existsSync(outputFile)) {
      text = fs.readFileSync(outputFile, "utf-8").trim();
    }
    const errorText = [eventError, stderrText.trim()].filter(Boolean).join("\n").trim();
    if (!text && errorText) {
      log("warn", `codex diagnostics: ${errorText.slice(-2500)}`);
    }
    return { text, newThreadId, failed, exitCode, errorText };
  };

  let res = await runOnce();
  if (options.shouldStop?.()) {
    return { ...res, cancelled: true };
  }
  if (!res.text && (res.failed || res.exitCode !== 0)) {
    const resumedThread = Boolean(sessionId);
    const contextFailure =
      /(?:status(?:\s+code)?\s*[:=]?\s*413|\b413\b|context[_ -]?length|maximum context|too many tokens|conversation[^\n]*too (?:large|long)|input[^\n]*too long)/i.test(
        res.errorText,
      );

    // A transient model/network failure should not throw away a healthy
    // conversation. Retry the same thread once before rotating.
    if (resumedThread && !contextFailure) {
      log("warn", "codex turn failed; retrying the existing thread once");
      await new Promise((r) => setTimeout(r, CODEX_RETRY_MS));
      if (options.shouldStop?.()) return { ...res, cancelled: true };
      res = await runOnce();
    }

    // Rotate only for a context/history failure, or after the same-thread
    // retry also failed. This preserves context across temporary API errors.
    if (!res.text && (res.failed || res.exitCode !== 0) && sessionId) {
      log("warn", "codex turn still failed; rotating to a fresh thread");
      sessionId = "";
      if (manager) saveManagerSession("");
      await new Promise((r) => setTimeout(r, CODEX_RETRY_MS));
      if (options.shouldStop?.()) return { ...res, cancelled: true };
      res = await runOnce();
    } else if (!res.text && (res.failed || res.exitCode !== 0) && !resumedThread) {
      log("warn", "fresh codex turn failed; retrying once");
      await new Promise((r) => setTimeout(r, CODEX_RETRY_MS));
      if (options.shouldStop?.()) return { ...res, cancelled: true };
      res = await runOnce();
    }
  }
  if (res.newThreadId) options.onThread?.(res.newThreadId);
  return res;
}

// ------------------------------------------------------- manager and jobs
const JOB_ACTIVE = new Set(["queued", "running"]);
const JOB_FINISHED = new Set(["succeeded", "failed", "cancelled"]);

function loadJobs() {
  if (!fs.existsSync(jobsFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(jobsFile, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((job) => job && typeof job.id === "string").map((job) => {
      if (JOB_ACTIVE.has(job.status)) {
        return {
          ...job,
          status: "failed",
          finishedAt: job.finishedAt || new Date().toISOString(),
          error: "微信桥在处理期间重启，任务已中断。",
        };
      }
      return job;
    });
  } catch (err) {
    log("warn", "jobs.json parse failed", String(err));
    return [];
  }
}

const jobs = loadJobs();

function saveJobs() {
  const active = jobs.filter((job) => JOB_ACTIVE.has(job.status));
  const finished = jobs
    .filter((job) => JOB_FINISHED.has(job.status))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(-40);
  jobs.splice(0, jobs.length, ...active, ...finished);
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
}
saveJobs();

function clip(text, max = 12000) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, max)}\n...(已截断)`;
}

function jobAge(job) {
  const start = Date.parse(job.startedAt || job.createdAt || "");
  if (!Number.isFinite(start)) return "未知";
  const mins = Math.max(0, Math.floor((Date.now() - start) / 60000));
  return mins < 1 ? "不到1分钟" : `${mins}分钟`;
}

function describeJobs() {
  const active = jobs.filter((job) => JOB_ACTIVE.has(job.status));
  const recent = jobs
    .filter((job) => JOB_FINISHED.has(job.status))
    .slice(-6)
    .reverse();
  const lines = [];
  if (!active.length) {
    lines.push("当前没有后台任务。");
  } else {
    lines.push("当前后台任务：");
    for (const job of active) {
      lines.push(
        `- #${job.id} ${job.status === "running" ? "执行中" : "排队中"}，已${jobAge(job)}：${clip(job.task, 260)}`,
      );
    }
  }
  if (recent.length) {
    lines.push("最近完成：");
    for (const job of recent) {
      const label =
        job.status === "succeeded" ? "成功" : job.status === "cancelled" ? "已取消" : "失败";
      lines.push(`- #${job.id} ${label}：${clip(job.task, 160)}`);
      if (job.status === "succeeded" && job.result) {
        const oneLineResult = String(job.result).replace(/\s+/g, " ").trim();
        lines.push(`  结果摘要：${clip(oneLineResult, 600)}`);
      }
    }
  }
  return lines.join("\n");
}

function buildManagerPrompt(event) {
  const common = [
    "【系统角色：微信 Codex 主管】",
    "你是用户微信里的常驻主管。你负责沟通、判断、拆解、派活、追踪和汇总；实际执行由独立后台工作进程完成。",
    "你这一轮是只读的，不要亲自修改文件、运行实现命令、做调研或代替工作进程干活。",
    "说话像一个可靠、简短、有判断的负责人，不要客服腔，不要长篇报告，不要假装任务已经完成。",
    "",
    "选择动作：",
    "- reply：闲聊、解释、确认、状态查询等不需要实际执行的内容，直接回复。",
    "- dispatch：需要实际查资料、读改文件、运行命令、写代码、操作软件或持续处理时，派给新的后台任务。task 必须自包含，写清目标、上下文和交付标准。reply 只做简短接单回复。",
    "- cancel：用户明确要求停止某个正在运行或排队的任务时使用，并在 job_id 填任务编号。",
    "",
    "约束：",
    "- 用户只是补充聊天、追问进度或修改方向时，不要卡住现有任务；需要新增实际工作时可另派任务。",
    "- 如果已有运行中任务，或最近几分钟的任务结果已经满足当前请求，不要再派重复任务；直接回答、确认或引用已有结果。",
    "- 用户围绕同一对象补发截图、文件名或短句时，先把它当作现有请求的补充证据，不要仅因附件形式变化就重复派单。",
    "- 用户没有明确取消时，绝不声称任务已停止。",
    "- 处理 job_finished 事件时，根据真实结果向用户汇总；不要再次派发同一任务。",
    "- 如果工作结果要求把本机媒体发到微信，原样保留独占一行的 [[send-image: 绝对路径]]、[[send-video: 绝对路径]] 或 [[send-file: 绝对路径]] 指令。",
    "- 最终必须严格按输出 schema 返回 JSON；不使用的字符串字段填空字符串。",
    "",
    describeJobs(),
  ];

  if (event.kind === "job_finished") {
    const job = event.job;
    common.push(
      "",
      "【后台任务完成事件】",
      `任务编号：#${job.id}`,
      `状态：${job.status}`,
      `原任务：${clip(job.task, 4000)}`,
      `结果或错误：\n${clip(job.result || job.error || "(无文本结果)", 12000)}`,
      "",
      "请以主管身份向用户交付结果。保留关键事实、路径、验证结果和失败原因；没有证据不要补造。",
    );
  } else {
    common.push(
      "",
      "【用户新消息】",
      clip(event.message, 20000),
      "",
      "先判断这是聊天还是需要实际执行。需要执行就派工并立刻回复；不需要就正常对话。",
    );
  }
  return common.join("\n");
}

async function managerTurn(event) {
  const prompt = buildManagerPrompt(event);
  if (MANAGER_API.enabled) {
    try {
      const historyUserText =
        event.kind === "job_finished"
          ? `[后台任务 #${event.job.id} ${event.job.status}]\n${clip(
              event.job.result || event.job.error || "",
              4000,
            )}`
          : event.message;
      const result = await requestManagerDecision({
        provider: MANAGER_API,
        prompt,
        historyUserText,
        history: managerHistory,
      });
      saveManagerHistory(result.history);
      log(
        "info",
        `manager direct action=${result.decision.action} latency=${result.latencyMs}ms`,
      );
      return result.decision;
    } catch (err) {
      log("warn", "direct manager failed, falling back to Codex CLI", String(err));
    }
  }
  const res = await codexTurn(prompt, {
    manager: true,
    sessionId: managerSessionId,
    timeoutMs: MANAGER_WAIT_MS,
    outputFile: managerReplyFile,
    onThread: (threadId) => saveManagerSession(threadId),
  });
  if (res.cancelled) return null;
  if (!res.text) {
    throw new Error(res.errorText || "manager returned no text");
  }
  return parseManagerDecision(res.text);
}

let managerQueue = Promise.resolve();
function enqueueManager(fn) {
  const task = managerQueue.then(fn, fn);
  managerQueue = task.catch(() => {});
  return task;
}

const pendingUserBatches = new Map();

function enqueueUserPrompt(from, prompt) {
  let batch = pendingUserBatches.get(from);
  if (!batch) {
    batch = { parts: [], timer: null, hasVisual: false };
    pendingUserBatches.set(from, batch);
  }
  batch.parts.push(String(prompt || ""));
  batch.hasVisual ||= batch.parts[batch.parts.length - 1].includes("[图片视觉转录]");
  if (batch.timer) clearTimeout(batch.timer);

  const delay = batch.hasVisual ? IMAGE_BATCH_MS : MESSAGE_BATCH_MS;
  batch.timer = setTimeout(() => {
    pendingUserBatches.delete(from);
    const parts = batch.parts.filter(Boolean);
    const combined =
      parts.length <= 1
        ? parts[0] || ""
        : parts.map((part, index) => `[同一批连续消息 ${index + 1}]\n${part}`).join("\n\n");
    if (!combined) return;
    log("info", `manager batch from=${from} parts=${parts.length}`);
    void processUserMessage(from, combined);
  }, delay);
  batch.timer.unref?.();
}

const sentMediaCache = new Map();

function mediaDedupKey(filePath) {
  try {
    const resolved = fs.realpathSync(filePath);
    const stat = fs.statSync(resolved);
    return `${resolved}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return String(filePath || "");
  }
}

function wasMediaRecentlySent(filePath) {
  const key = mediaDedupKey(filePath);
  const sentAt = sentMediaCache.get(key);
  if (!sentAt) return false;
  if (Date.now() - sentAt > MEDIA_DEDUPE_MS) {
    sentMediaCache.delete(key);
    return false;
  }
  return true;
}

async function deliverLeaderReply(from, reply, { voice = true } = {}) {
  if (!reply) return;
  const ctxToken = contextTokens[from] ?? "";
  const { media, text: replyText } = extractMediaDirectives(reply);
  let sentVoice = 0;
  if (voice && replyText && BREEZE_TTS.enabled) {
    try {
      const voiceResult = await sendBreezeVoiceReply({
        account,
        to: from,
        ctxToken,
        replyText,
        config: BREEZE_TTS,
        outputDir: voiceDir,
      });
      sentVoice = voiceResult.sent;
      if (voiceResult.skipped) {
        log("info", `voice skipped reason=${voiceResult.skipped}`);
      }
      if (sentVoice) {
        log("info", `voice replied to=${from} messages=${sentVoice}`);
      }
    } catch (err) {
      log("error", "voice reply failed, falling back to text", String(err));
    }
  }
  if (!sentVoice || BREEZE_TTS.alsoSendText) {
    if (replyText) {
      await sendReply(from, ctxToken, replyText);
      log("info", `text replied to=${from} len=${replyText.length}`);
    }
  }
  for (const item of media) {
    if (wasMediaRecentlySent(item.path)) {
      log("info", `media duplicate suppressed kind=${item.kind} path=${item.path}`);
      continue;
    }
    try {
      await sendMedia(from, ctxToken, item.path, item.kind);
      sentMediaCache.set(mediaDedupKey(item.path), Date.now());
    } catch (err) {
      log("error", `sendMedia failed (${item.kind} ${item.path})`, String(err));
    }
  }
}

const jobChildren = new Map();
let runningJobCount = 0;

function findJob(id) {
  const wanted = String(id || "").replace(/^#/, "").trim();
  if (!wanted) return null;
  return jobs.find((job) => job.id === wanted || job.id.startsWith(wanted)) || null;
}

function cancelJob(id) {
  const job = findJob(id);
  if (!job || !JOB_ACTIVE.has(job.status)) return null;
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  job.error = "用户取消";
  saveJobs();
  const child = jobChildren.get(job.id);
  if (child) {
    killChildTree(child);
  }
  log("info", `job cancelled id=${job.id}`);
  return job;
}

function queueJob(task, from) {
  const job = {
    id: crypto.randomBytes(3).toString("hex"),
    status: "queued",
    task: String(task || "").trim(),
    from,
    createdAt: new Date().toISOString(),
    startedAt: "",
    finishedAt: "",
    workerThreadId: "",
    result: "",
    error: "",
  };
  jobs.push(job);
  saveJobs();
  log("info", `job queued id=${job.id} from=${from} len=${job.task.length}`);
  pumpJobQueue();
  return job;
}

function workerPrompt(job) {
  return [
    "【后台工作指令】",
    `任务编号：#${job.id}`,
    `用户原始请求：${clip(job.task, 18000)}`,
    "",
    "你是独立工作进程。直接完成这项任务，不要把工作再派给别人，也不要扮演微信主管。",
    "遵循工作区规则，实际检查文件/系统状态，修改后做必要验证。",
    "最终回复只交付结果：完成了什么、关键证据或路径、验证结果；失败就明确失败点和已尝试的路径。",
    "如果需要把本机文件发到微信，可在最终回复中加入独占一行的 [[send-image: 绝对路径]]、[[send-video: 绝对路径]] 或 [[send-file: 绝对路径]]。",
  ].join("\n");
}

async function runJob(job) {
  if (job.status !== "queued") return;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  saveJobs();
  log("info", `job started id=${job.id}`);

  const outputFile = path.join(jobRepliesDir, `${job.id}.txt`);
  const heartbeat = setInterval(() => {
    if (job.status !== "running") return;
    sendMessage(
      job.from,
      contextTokens[job.from] ?? "",
      `任务 #${job.id} 还在做，已经 ${jobAge(job)}。你继续吩咐，我这边不会打断它。`,
    ).catch((err) => log("warn", `job progress send failed id=${job.id}`, String(err)));
  }, JOB_PROGRESS_MS);
  heartbeat.unref?.();

  let shouldNotify = false;
  try {
    const res = await codexTurn(workerPrompt(job), {
      manager: false,
      sessionId: "",
      timeoutMs: JOB_WAIT_MS,
      outputFile,
      onChild: (child) => {
        if (child) jobChildren.set(job.id, child);
        else jobChildren.delete(job.id);
      },
      onThread: (threadId) => {
        job.workerThreadId = threadId;
        saveJobs();
      },
      shouldStop: () => job.status === "cancelled",
    });
    if (job.status === "cancelled" || res.cancelled) return;
    if (res.text) {
      job.status = "succeeded";
      job.result = clip(res.text, 30000);
      shouldNotify = true;
    } else {
      job.status = "failed";
      job.error = clip(res.errorText || `worker exited ${res.exitCode}`, 4000);
      shouldNotify = true;
    }
  } catch (err) {
    if (job.status !== "cancelled") {
      job.status = "failed";
      job.error = clip(String(err), 4000);
      shouldNotify = true;
    }
  } finally {
    clearInterval(heartbeat);
    jobChildren.delete(job.id);
    job.finishedAt = new Date().toISOString();
    saveJobs();
    runningJobCount = Math.max(0, runningJobCount - 1);
    log("info", `job finished id=${job.id} status=${job.status}`);
    pumpJobQueue();
  }

  if (shouldNotify) {
    void notifyJobFinished(job).catch((err) => {
      log("error", `job result notify failed id=${job.id}`, String(err));
      const fallback =
        job.status === "succeeded"
          ? `任务 #${job.id} 做完了：\n${clip(job.result, 1600)}`
          : `任务 #${job.id} 失败了：${clip(job.error, 800)}`;
      sendMessage(job.from, contextTokens[job.from] ?? "", fallback).catch(() => {});
    });
  }
}

function pumpJobQueue() {
  while (runningJobCount < JOB_CONCURRENCY) {
    const job = jobs.find((item) => item.status === "queued");
    if (!job) return;
    runningJobCount += 1;
    void runJob(job);
  }
}

async function notifyJobFinished(job) {
  await enqueueManager(async () => {
    const decision = await managerTurn({ kind: "job_finished", job });
    const fallback =
      job.status === "succeeded"
        ? `任务 #${job.id} 做完了：\n${clip(job.result, 6000)}`
        : `任务 #${job.id} 失败了：${clip(job.error, 2000)}`;
    const reply =
      decision?.action === "reply" && decision.reply.trim()
        ? decision.reply.trim()
        : fallback;
    await deliverLeaderReply(job.from, reply);
  });
}

async function processUserMessage(from, prompt) {
  try {
    const decision = await enqueueManager(() =>
      managerTurn({ kind: "user_message", message: prompt }),
    );
    let reply = decision?.reply?.trim() || "";

    if (decision?.action === "dispatch") {
      const job = queueJob(decision.task || prompt, from);
      if (!reply) reply = `收到，我安排 #${job.id} 去处理。`;
    } else if (decision?.action === "cancel") {
      const cancelled = cancelJob(decision.jobId);
      if (!reply) {
        reply = cancelled
          ? `好，#${cancelled.id} 已经停了。`
          : "现在没有找到可停的任务。";
      }
    } else if (!reply) {
      reply = "我在，你说。";
    }

    await deliverLeaderReply(from, reply);
  } catch (err) {
    log("error", "manager turn failed", String(err));
    try {
      await sendMessage(from, contextTokens[from] ?? "", "主管会话刚才没接上，你再说一遍。");
    } catch {}
  } finally {
    await sendTyping(from, contextTokens[from] ?? "", 2);
  }
}

// ----------------------------------------------------------------- handle
async function handleMessage(msg) {
  if (msg.message_type === 2) return; // bot's own echoes
  const from = msg.from_user_id ?? "";
  if (!from) return;
  const mid = String(msg.message_id ?? `${msg.seq ?? ""}:${msg.create_time_ms ?? ""}`);
  if (!mid || seenIds.has(mid)) return;
  seenIds.add(mid);
  saveSeen();

  if (msg.context_token) {
    contextTokens[from] = msg.context_token;
    saveContextTokens();
  }
  const ctxToken = contextTokens[from] ?? "";

  const text = bodyFromItemList(msg.item_list);
  const { imageItems } = itemTypes(msg.item_list);
  const hasVoice = (msg.item_list ?? []).some((i) => i?.type === 3);
  log(
    "info",
    `msg from=${maskIdentifier(from)} len=${text.length} images=${imageItems.length} mid=${maskIdentifier(mid)} ctx=${msg.context_token ? "present" : "none"}`,
  );

  if (!text && imageItems.length === 0) {
    const notice = hasVoice ? "语音消息暂不支持,请发文字或图片" : "这条消息暂不支持(可发文字/图片)";
    try {
      await sendMessage(from, ctxToken, notice);
    } catch (err) {
      log("warn", "unsupported notice failed", String(err));
    }
    return;
  }

  await sendTyping(from, ctxToken, 1);
  try {
    let prompt = text;
    let appImages = [];
    if (imageItems.length > 0) {
      const transcripts = [];
      const savedPaths = [];
      for (let i = 0; i < imageItems.length; i++) {
        const item = imageItems[i];
        const { buffer, mediaType } = await downloadImage(item, `img mid=${mid} #${i}`);
        log("info", `image downloaded mid=${mid} bytes=${buffer.length} type=${mediaType}`);
        const ext = (mediaType.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const filePath = path.join(imagesDir, `${mid}-${i}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        savedPaths.push(filePath);
        if (VISION_API_KEY && !APP_CLIENT?.ready) {
          try {
            const r = await visionTranscribe(buffer, mediaType);
            log("info", `vision transcript len=${r.text.length} model=${r.model}`);
            transcripts.push(r.text);
          } catch (err) {
            log("error", "vision transcribe failed", String(err));
            transcripts.push("");
          }
        } else {
          transcripts.push("");
        }
      }
      appImages = savedPaths;
      const parts = [];
      if (text) parts.push(text);
      if (!APP_CLIENT?.ready) {
        parts.push(
          `[图片视觉转录]\n${transcripts.map((t) => (t && t.trim()) ? t : "(识别失败)").join("\n---\n")}`,
        );
      }
      parts.push(`[图片已保存到本机]\n${savedPaths.join("\n")}`);
      parts.push("请直接查看上述本地图片文件；视觉转录仅作辅助，若转录为空或不完整，以图片本身为准。");
      prompt = parts.join("\n\n");
    }

    if (APP_CLIENT?.ready) {
      appLastFrom = from;
      const inputs = [{ type: "text", text: prompt }];
      for (const imagePath of appImages) {
        inputs.push({ type: "localImage", path: imagePath });
      }
      const outcome = await APP_CLIENT.sendInput(inputs);
      log("info", `app-server accepted mode=${outcome.mode} turn=${outcome.turnId || ""}`);
      if (outcome.mode === "steered") {
        await sendMessage(from, ctxToken, "收到，已经接进当前这件事。");
      } else if (outcome.mode === "queued") {
        await sendMessage(from, ctxToken, "收到，等当前步骤收尾后接着处理。");
      }
      return;
    }

    // Coalesce rapid text/image follow-ups from the same user before asking the
    // manager to decide. This prevents one screenshot chain from being split
    // into redundant jobs and replies.
    enqueueUserPrompt(from, prompt);
  } catch (err) {
    log("error", "handleMessage failed", String(err));
    try {
      await sendMessage(from, ctxToken, "（桥接出错,稍后重试）");
    } catch {}
    await sendTyping(from, ctxToken, 2);
  }
}

// ------------------------------------------------------------- main loop
let running = true;
// Windows Task Scheduler / schtasks /End delivers Ctrl+C; ignore it (same
// policy as dsh-weixin-direct) so a task stop does not kill us mid-reply.
process.on("SIGINT", () => {
  log("warn", "SIGINT received, ignoring - use SIGTERM or Stop-Process -Force to stop");
});
process.on("SIGTERM", async () => {
  running = false;
  APP_CLIENT?.stop();
  for (const child of jobChildren.values()) {
    killChildTree(child);
  }
  await notifyStop();
  process.exit(0);
});

async function main() {
  log("info", `starting workspace=${WORKSPACE_DIR} state=${STATE_DIR}`);
  const appServerStarted = await startAppServer();
  if (!appServerStarted) {
    log(
      "info",
      MANAGER_API.enabled
        ? `fallback manager provider=direct model=${MANAGER_API.model}`
        : `fallback manager provider=codex-cli reason=${MANAGER_API.reason}`,
    );
  }
  await notifyStart();
  let consecutiveErrors = 0;
  let incomingQueue = Promise.resolve();
  while (running) {
    let resp;
    try {
      resp = await getUpdates();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      log("error", "getUpdates failed", String(err));
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * consecutiveErrors)));
      continue;
    }
    if (resp.errcode === -14) {
      log("error", "STALE TOKEN (-14): re-login via `openclaw channels login --channel openclaw-weixin`");
      await new Promise((r) => setTimeout(r, 60000));
      continue;
    }
    if (resp.ret && resp.ret !== 0) {
      log("warn", "getUpdates ret", resp.ret, resp.errmsg ?? "");
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (resp.get_updates_buf) {
      syncBuf = resp.get_updates_buf;
      saveSyncBuf();
    }
    const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
    if (msgs.length) log("info", `poll got ${msgs.length} msg(s)`);
    for (const msg of msgs) {
      incomingQueue = incomingQueue.then(() => handleMessage(msg)).catch((err) => {
        log("error", "handleMessage failed", String(err));
      });
    }
  }
}

main().catch((err) => {
  log("error", "fatal", String(err));
  process.exit(1);
});
