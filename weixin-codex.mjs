#!/usr/bin/env node
// WeChat <-> Codex bridge.
// Transport: WeChat iLink Bot backend (getupdates long-poll + sendmessage),
// reusing the openclaw-weixin account credentials (same as dsh-weixin-direct).
// Brain: the local Codex CLI (`codex exec`, same model/permissions as the
// desktop app). Text goes straight to Codex; images are transcribed by the
// DeepSeek multimodal (vision) model first, then the transcript is fed to Codex.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createDecipheriv } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractMediaDirectives } from "./directives.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const file = path.join(SCRIPT_DIR, "config.json");
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

const ACCOUNT_DIR =
  CFG.accountDir || path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
const ACCOUNT_ID = CFG.accountId || process.env.WEIXIN_ACCOUNT_ID || "";
if (!ACCOUNT_ID) {
  console.error("accountId is required (config.json accountId or WEIXIN_ACCOUNT_ID)");
  process.exit(2);
}

const STATE_DIR = CFG.stateDir || path.join(SCRIPT_DIR, "state");
const WORKSPACE_DIR = CFG.workspaceDir || SCRIPT_DIR;
const WAIT_MS = Number.isFinite(CFG.waitMs) ? CFG.waitMs : 600000;

const VISION_BASE = CFG.visionBaseUrl || "https://api.deepseek.com";
const VISION_MODEL = CFG.visionModel || "deepseek-v4-flash-vision-exp";
const VISION_MAX_TOKENS = Number.isFinite(CFG.visionMaxTokens) ? CFG.visionMaxTokens : 1024;
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

const CODEX_NODE = CFG.codexNode || "node";
const CODEX_CLI = CFG.codexCli || "";

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
const sessionFile = path.join(STATE_DIR, "codex-session.json");
const replyFile = path.join(STATE_DIR, "reply.txt");
const imagesDir = path.join(STATE_DIR, "images");
fs.mkdirSync(imagesDir, { recursive: true });

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

let codexSessionId = "";
if (fs.existsSync(sessionFile)) {
  try {
    codexSessionId = JSON.parse(fs.readFileSync(sessionFile, "utf-8")).threadId || "";
  } catch {}
}
const saveCodexSession = (threadId) => {
  codexSessionId = threadId;
  fs.writeFileSync(sessionFile, JSON.stringify({ threadId }));
};

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
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = { model, messages, max_tokens: VISION_MAX_TOKENS };
      try {
        const res = await fetch(`${VISION_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${VISION_API_KEY}`,
          },
          body: JSON.stringify(body),
        });
        if (res.status === 429) {
          lastErr = new Error(`${model} 429`);
          await new Promise((r) => setTimeout(r, 8000 + Math.floor(Math.random() * 2000)));
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
        if (String(err?.message).includes("429")) continue;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw lastErr || new Error("DeepSeek vision failed");
}

// ------------------------------------------------------------------- codex
function codexArgs() {
  const args = codexSessionId ? ["exec", "resume", codexSessionId] : ["exec", "-C", WORKSPACE_DIR];
  args.push("--skip-git-repo-check");
  args.push("--dangerously-bypass-approvals-and-sandbox");
  // The desktop config registers a `notify` hook that pings the desktop app on
  // every turn; silence it for WeChat turns to avoid notification spam.
  args.push("-c", "notify=[]");
  args.push("--json");
  args.push("-o", replyFile);
  args.push("-");
  return args;
}

async function codexTurn(promptText) {
  const runOnce = async () => {
    if (fs.existsSync(replyFile)) fs.unlinkSync(replyFile);
    const args = codexArgs();
    const env = { ...process.env };
    // These belong to the desktop-app thread that spawned us; strip them so the
    // child CLI manages its own session instead of targeting this one.
    delete env.CODEX_SESSION_ID;
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;

    const child = spawn(CODEX_NODE, CODEX_CLI ? [CODEX_CLI, ...args] : args, {
      stdio: ["pipe", "pipe", "ignore"],
      env,
      windowsHide: true,
    });

    let lastAgentText = "";
    let newThreadId = "";
    let failed = false;
    let exitCode = null;
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
        if (ev.type === "error" || ev.type === "turn.failed") failed = true;
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
        log("warn", "codex turn timed out, killing");
        try {
          child.kill();
        } catch {}
        // Give the killed child a short window to flush, then move on.
        setTimeout(finish, 15000);
      }, WAIT_MS);
      child.on("close", (code) => {
        exitCode = code;
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

    if (stdoutBuf.trim()) handleLine(stdoutBuf);

    let text = lastAgentText;
    if (!text && fs.existsSync(replyFile)) {
      text = fs.readFileSync(replyFile, "utf-8").trim();
    }
    return { text, newThreadId, failed, exitCode };
  };

  let res = await runOnce();
  // If resuming a stale/oversized thread failed (no reply + error/exit), start
  // a brand-new thread and retry the same prompt once.
  if (!res.text && (res.failed || res.exitCode !== 0) && codexSessionId) {
    log(
      "warn",
      "codex turn failed (previous thread may be too large), rotating to a fresh thread",
    );
    saveCodexSession("");
    res = await runOnce();
  }
  if (res.newThreadId && !codexSessionId) saveCodexSession(res.newThreadId);
  return res.text;
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
    `msg from=${from} len=${text.length} images=${imageItems.length} mid=${mid} ctxTok=${msg.context_token ? String(msg.context_token).slice(0, 10) + "..." : "NONE"}`,
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
        if (VISION_API_KEY) {
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
      const gotTranscript = transcripts.some((t) => t && t.trim());
      if (!gotTranscript) {
        await sendMessage(from, ctxToken, "图片识别暂时被限流或失败,请稍后再发一次(图片已保存到本机)。");
        return;
      }
      const parts = [];
      if (text) parts.push(text);
      parts.push(
        `[图片视觉转录]\n${transcripts.map((t) => (t && t.trim()) ? t : "(识别失败)").join("\n---\n")}`,
      );
      parts.push(`[图片已保存到本机]\n${savedPaths.join("\n")}`);
      prompt = parts.join("\n\n");
    }

    const reply = await codexTurn(prompt);
    const { media, text: replyText } = extractMediaDirectives(reply);
    if (replyText) {
      await sendReply(from, ctxToken, replyText);
      log("info", `replied to=${from} len=${replyText.length}`);
    }
    for (const m of media) {
      try {
        await sendMedia(from, ctxToken, m.path, m.kind);
      } catch (err) {
        log("error", `sendMedia failed (${m.kind} ${m.path})`, String(err));
      }
      // Small gap so WeChat renders text then media in order.
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!replyText && media.length === 0) {
      await sendMessage(from, ctxToken, "（Codex 处理完成,但没有文字回复;可能是超时,稍后再试）");
      log("warn", `empty codex reply for from=${from}`);
    }
  } catch (err) {
    log("error", "handleMessage failed", String(err));
    try {
      await sendMessage(from, ctxToken, "（桥接出错,稍后重试）");
    } catch {}
  } finally {
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
  await notifyStop();
  process.exit(0);
});

async function main() {
  log("info", `starting, account=${ACCOUNT_ID} baseUrl=${baseUrl} userId=${userId}`);
  await notifyStart();
  let consecutiveErrors = 0;
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
      try {
        await handleMessage(msg);
      } catch (err) {
        log("error", "handleMessage failed", String(err));
      }
    }
  }
}

main().catch((err) => {
  log("error", "fatal", String(err));
  process.exit(1);
});
