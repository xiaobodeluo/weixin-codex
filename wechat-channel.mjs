#!/usr/bin/env node
// WeChat channel CLI for driving WeChat from an interactive Codex session
// (the desktop App conversation). It owns the iLink transport the same way the
// bridge does and shares the bridge's config.json / state/ / account cursor, so
// switching between the two never loses or replays messages.
//
//   node wechat-channel.mjs contacts
//   node wechat-channel.mjs poll [--seconds N] [--to <id>]
//   node wechat-channel.mjs send [--to <id>] [--text "..."]   (or text on stdin)
//   node wechat-channel.mjs send-media --path <file> [--kind image|video|file] [--to <id>] [--caption "..."]
//
// Every command prints a single JSON object on stdout.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createDecipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveFromScript } from "./weixin-account.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  try {
    const file = process.env.WEIXIN_CONFIG || path.join(SCRIPT_DIR, "config.json");
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}
const CFG = loadConfig();

const ACCOUNT_DIR =
  resolveFromScript(process.env.WEIXIN_ACCOUNT_DIR || CFG.accountDir) ||
  path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
const ACCOUNT_ID = process.env.WEIXIN_ACCOUNT_ID || CFG.accountId || "";
const STATE_DIR =
  resolveFromScript(process.env.WEIXIN_STATE_DIR || CFG.stateDir) ||
  path.join(SCRIPT_DIR, "state");

const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.4.6";
const CLIENT_VERSION = String(((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff));
const BOT_AGENT = "Codex/1.0";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_REPLY_CHUNK = 1900;

const VISION_BASE = CFG.visionBaseUrl || "https://api.deepseek.com";
const VISION_MODEL = CFG.visionModel || "deepseek-v4-flash-vision-exp";
const VISION_MAX_TOKENS = Number.isFinite(CFG.visionMaxTokens) ? CFG.visionMaxTokens : 1024;
const VISION_MODELS =
  Array.isArray(CFG.visionModels) && CFG.visionModels.length ? CFG.visionModels : [VISION_MODEL];

function fail(message, code = 1) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(code);
}

if (!ACCOUNT_ID) fail("accountId is required (config.json accountId or WEIXIN_ACCOUNT_ID)", 2);

fs.mkdirSync(STATE_DIR, { recursive: true });
const seenFile = path.join(STATE_DIR, "seen-ids.json");
const imagesDir = path.join(STATE_DIR, "images");
fs.mkdirSync(imagesDir, { recursive: true });

const seenIds = new Set(
  fs.existsSync(seenFile) ? JSON.parse(fs.readFileSync(seenFile, "utf-8")) : [],
);
const saveSeen = () => fs.writeFileSync(seenFile, JSON.stringify([...seenIds].slice(-2000)));

const accountFile = path.join(ACCOUNT_DIR, ACCOUNT_ID + ".json");
const syncFile = path.join(ACCOUNT_DIR, ACCOUNT_ID + ".sync.json");
const tokensFile = path.join(ACCOUNT_DIR, ACCOUNT_ID + ".context-tokens.json");

if (!fs.existsSync(accountFile)) fail("account file not found: " + accountFile);
const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
const { token, baseUrl, userId } = account;

let syncBuf = "";
if (fs.existsSync(syncFile)) {
  try {
    syncBuf = JSON.parse(fs.readFileSync(syncFile, "utf-8")).get_updates_buf || "";
  } catch {}
}
const saveSyncBuf = () => fs.writeFileSync(syncFile, JSON.stringify({ get_updates_buf: syncBuf }));

const contextTokens = fs.existsSync(tokensFile)
  ? JSON.parse(fs.readFileSync(tokensFile, "utf-8"))
  : {};
const saveContextTokens = () => fs.writeFileSync(tokensFile, JSON.stringify(contextTokens));

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ iLink api
function wechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}
function headers() {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: "Bearer " + token,
    "X-WECHAT-UIN": wechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
}
const baseInfo = () => ({ channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT });

async function wxPost(endpoint, body, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl.replace(/\/$/, "") + "/" + endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error("wx " + endpoint + " HTTP " + res.status + ": " + raw.slice(0, 300));
    return JSON.parse(raw);
  } finally {
    clearTimeout(t);
  }
}

async function getUpdates(timeoutMs) {
  try {
    return await wxPost(
      "ilink/bot/getupdates",
      { get_updates_buf: syncBuf, base_info: baseInfo() },
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: syncBuf };
    }
    throw err;
  }
}

async function sendMessage(to, ctxToken, text) {
  const clientId = "wechat-channel:" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
  const resp = await wxPost("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: ctxToken,
      run_id: "channel-" + crypto.randomUUID(),
    },
    base_info: baseInfo(),
  });
  if (resp.ret && resp.ret !== 0) throw new Error("sendMessage ret=" + resp.ret + " errmsg=" + (resp.errmsg || ""));
}

async function sendText(to, ctxToken, text) {
  for (let i = 0; i < text.length; i += MAX_REPLY_CHUNK) {
    await sendMessage(to, ctxToken, text.slice(i, i + MAX_REPLY_CHUNK));
  }
}

const aesEcbPaddedSize = (n) => Math.ceil((n + 1) / 16) * 16;

async function sendMedia(to, ctxToken, filePath, kind) {
  if (!fs.existsSync(filePath)) throw new Error("file not found: " + filePath);
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
  if (up.ret && up.ret !== 0) throw new Error("getuploadurl ret=" + up.ret + " errmsg=" + (up.errmsg || ""));
  const uploadFullUrl = up.upload_full_url ? up.upload_full_url.trim() : "";
  const uploadParam = up.upload_param;
  if (!uploadFullUrl && !uploadParam) throw new Error("getuploadurl returned no upload URL");
  const cdnUrl = uploadFullUrl
    ? uploadFullUrl
    : CDN_BASE_URL + "/upload?encrypted_query_param=" + encodeURIComponent(uploadParam) + "&filekey=" + encodeURIComponent(filekey);

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
        const msg = res.headers.get("x-error-message") || (await res.text());
        throw new Error("CDN HTTP " + res.status + ": " + String(msg).slice(0, 300));
      }
      downloadParam = res.headers.get("x-encrypted-param") || undefined;
      if (!downloadParam) throw new Error("CDN response missing x-encrypted-param header");
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  if (!downloadParam) throw lastError instanceof Error ? lastError : new Error("CDN upload failed");

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
        : { type: 4, file_item: { media, file_name: path.basename(filePath), len: String(rawsize) } };

  const clientId = "wechat-channel:" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
  const resp = await wxPost("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [item],
      context_token: ctxToken,
      run_id: "channel-" + crypto.randomUUID(),
    },
    base_info: baseInfo(),
  });
  if (resp.ret && resp.ret !== 0) throw new Error("sendmessage ret=" + resp.ret + " errmsg=" + (resp.errmsg || ""));
}

// ------------------------------------------------------------------ inbound
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
      return parts.length ? "[引用: " + parts.join(" | ") + "]\n" + text : text;
    }
    if (item.type === 3 && item.voice_item && item.voice_item.text) return String(item.voice_item.text);
  }
  return "";
}

function imageItems(itemList) {
  return (Array.isArray(itemList) ? itemList : []).filter((i) => i && i.type === 2 && i.image_item);
}

function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(label + ": bad aes_key (" + decoded.length + " bytes)");
}

function imageMediaType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.toString("ascii", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length > 3 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return "";
}

async function downloadImage(item, label) {
  const img = item && item.image_item;
  const qp = (img && img.media && img.media.encrypt_query_param) || "";
  const fullUrl = (img && img.media && img.media.full_url) || "";
  if (!qp && !fullUrl) throw new Error(label + ": image item has no encrypt_query_param/full_url");
  const url = fullUrl || CDN_BASE_URL + "/download?encrypted_query_param=" + encodeURIComponent(qp);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(label + ": CDN download HTTP " + res.status);
  const encrypted = Buffer.from(await res.arrayBuffer());
  const aesKeyBase64 = img.aeskey
    ? Buffer.from(img.aeskey, "hex").toString("base64")
    : (img.media && img.media.aes_key) || "";
  if (!aesKeyBase64) return { buffer: encrypted, mediaType: imageMediaType(encrypted) || "image/jpeg" };
  const key = parseAesKey(aesKeyBase64, label);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  const buffer = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const mediaType = imageMediaType(buffer);
  if (!mediaType) throw new Error(label + ": decrypted " + buffer.length + " bytes with no image magic");
  return { buffer, mediaType };
}

async function visionTranscribe(buffer, mediaType) {
  const dataUrl = "data:" + mediaType + ";base64," + buffer.toString("base64");
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
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(VISION_BASE + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + VISION_API_KEY },
          body: JSON.stringify({ model, messages, max_tokens: VISION_MAX_TOKENS }),
        });
        if (res.status === 429) {
          lastErr = new Error(model + " 429");
          await sleep(8000);
          continue;
        }
        const raw = await res.text();
        if (!res.ok) throw new Error(model + " HTTP " + res.status + ": " + raw.slice(0, 200));
        const content = JSON.parse(raw).choices[0].message.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b) => b && b.type === "text").map((b) => b.text).join("")
              : "";
        if (text && text.trim()) return { text: text.trim(), model };
        throw new Error(model + " empty reply");
      } catch (err) {
        lastErr = err;
        await sleep(1500);
      }
    }
  }
  throw lastErr || new Error("vision transcription failed");
}

// ------------------------------------------------------------------ helpers
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function defaultTarget(explicit) {
  return explicit || Object.keys(contextTokens)[0] || userId;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ------------------------------------------------------------------ commands
async function cmdContacts() {
  const contacts = Object.keys(contextTokens).map((id) => ({
    id,
    hasContextToken: Boolean(contextTokens[id]),
  }));
  process.stdout.write(
    JSON.stringify({ ok: true, self: userId, account: ACCOUNT_ID, contacts }, null, 2) + "\n",
  );
}

async function cmdPoll(args) {
  const seconds = Number(args.seconds || args.timeout || 5);
  const timeoutMs = Math.max(1000, Math.min(120000, seconds * 1000));
  const resp = await getUpdates(timeoutMs);
  if (resp.errcode === -14) fail("STALE TOKEN (-14): re-login via openclaw channels login");
  if (resp.ret && resp.ret !== 0) fail("getUpdates ret=" + resp.ret + " " + (resp.errmsg || ""));
  if (resp.get_updates_buf) {
    syncBuf = resp.get_updates_buf;
    saveSyncBuf();
  }
  const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
  const messages = [];
  for (const msg of msgs) {
    if (msg.message_type === 2) continue;
    const from = msg.from_user_id || "";
    if (!from) continue;
    const mid = String(msg.message_id != null ? msg.message_id : (msg.seq || "") + ":" + (msg.create_time_ms || ""));
    if (!mid || seenIds.has(mid)) continue;
    seenIds.add(mid);

    if (msg.context_token) {
      contextTokens[from] = msg.context_token;
      saveContextTokens();
    }
    const text = bodyFromItemList(msg.item_list);
    const imgs = imageItems(msg.item_list);
    const images = [];
    for (let i = 0; i < imgs.length; i++) {
      try {
        const dl = await downloadImage(imgs[i], "mid=" + mid + " #" + i);
        const ext = (dl.mediaType.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const filePath = path.join(imagesDir, mid + "-" + i + "." + ext);
        fs.writeFileSync(filePath, dl.buffer);
        let transcript = "";
        let transcriptError = "";
        if (VISION_API_KEY) {
          try {
            transcript = (await visionTranscribe(dl.buffer, dl.mediaType)).text;
          } catch (err) {
            transcriptError = String((err && err.message) || err);
          }
        } else {
          transcriptError = "DEEPSEEK_API_KEY not set";
        }
        images.push({ path: filePath, bytes: dl.buffer.length, mediaType: dl.mediaType, transcript, transcriptError });
      } catch (err) {
        images.push({ path: "", error: String((err && err.message) || err) });
      }
    }
    messages.push({
      mid,
      from,
      text,
      images,
      contextToken: contextTokens[from] || "",
      ts: msg.create_time_ms || null,
    });
  }
  saveSeen();
  process.stdout.write(JSON.stringify({ ok: true, count: messages.length, messages }, null, 2) + "\n");
}

async function cmdSend(args) {
  let text = typeof args.text === "string" ? args.text : "";
  if (!text) text = await readStdin();
  if (!text) fail('no text (use --text "..." or pipe on stdin)');
  const to = defaultTarget(typeof args.to === "string" ? args.to : "");
  const ctxToken = contextTokens[to] || "";
  await sendText(to, ctxToken, text);
  process.stdout.write(JSON.stringify({ ok: true, to, chars: text.length }) + "\n");
}

async function cmdSendMedia(args) {
  const filePath = typeof args.path === "string" ? args.path : "";
  if (!filePath) fail("--path is required");
  let kind = typeof args.kind === "string" ? args.kind : "";
  if (!kind) {
    const ext = path.extname(filePath).toLowerCase();
    kind = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
      ? "image"
      : [".mp4", ".mov", ".m4v", ".webm"].includes(ext)
        ? "video"
        : "file";
  }
  if (!["image", "video", "file"].includes(kind)) fail("bad --kind: " + kind);
  const to = defaultTarget(typeof args.to === "string" ? args.to : "");
  const ctxToken = contextTokens[to] || "";
  if (typeof args.caption === "string" && args.caption) await sendText(to, ctxToken, args.caption);
  const abs = path.resolve(filePath);
  await sendMedia(to, ctxToken, abs, kind);
  process.stdout.write(JSON.stringify({ ok: true, to, kind, path: abs }) + "\n");
}

// ------------------------------------------------------------------ main
const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));

try {
  if (cmd === "contacts") await cmdContacts();
  else if (cmd === "poll") await cmdPoll(args);
  else if (cmd === "send") await cmdSend(args);
  else if (cmd === "send-media") await cmdSendMedia(args);
  else {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: "unknown command",
        commands: ["contacts", "poll", "send", "send-media"],
        usage: [
          "node wechat-channel.mjs contacts",
          "node wechat-channel.mjs poll [--seconds N]",
          "node wechat-channel.mjs send [--text ...]",
          "node wechat-channel.mjs send-media --path <file> [--kind image|video|file]",
        ],
      }) + "\n",
    );
    process.exit(2);
  }
} catch (err) {
  fail(String((err && err.message) || err));
}
