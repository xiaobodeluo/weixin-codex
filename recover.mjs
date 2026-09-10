// One-off recovery: transcribe an already-saved inbound image, ask the Codex
// session to answer it, and send the reply back to WeChat. Used to replay a
// message whose transcription had been rate-limited.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "config.json"), "utf-8"));
const ACCOUNT_DIR = CFG.accountDir || path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
const ACCOUNT_ID = CFG.accountId || process.env.WEIXIN_ACCOUNT_ID || "";
const STATE_DIR = CFG.stateDir || path.join(SCRIPT_DIR, "state");
const WORKSPACE_DIR = CFG.workspaceDir || SCRIPT_DIR;
const CODEX_NODE = CFG.codexNode || "node";
const CODEX_CLI = CFG.codexCli || "";
const VISION_BASE = CFG.visionBaseUrl || "https://api.deepseek.com";
const VISION_MODELS = Array.isArray(CFG.visionModels) && CFG.visionModels.length
  ? CFG.visionModels
  : [CFG.visionModel || "deepseek-v4-flash-vision-exp"];
const VISION_MAX_TOKENS = CFG.visionMaxTokens || 1024;

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".dsh", ".credentials.yaml"), "utf-8");
    const m = raw.match(/^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}
const VISION_API_KEY = loadKey();

const account = JSON.parse(fs.readFileSync(path.join(ACCOUNT_DIR, `${ACCOUNT_ID}.json`), "utf-8"));
const tokens = JSON.parse(fs.readFileSync(path.join(ACCOUNT_DIR, `${ACCOUNT_ID}.context-tokens.json`), "utf-8"));
const target = Object.keys(tokens)[0];
const ctxToken = tokens[target] || "";
const sessionId = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "codex-session.json"), "utf-8")).threadId;

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("usage: node recover.mjs <image-file>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function transcribe(buffer, mediaType) {
  const dataUrl = `data:${mediaType};base64,${buffer.toString("base64")}`;
  const messages = [{ role: "user", content: [
    { type: "text", text: "完整转录这张图片中的所有内容(文字、数字、表格逐行逐格),不要总结、不要评价、不要省略。直接输出转录文本。" },
    { type: "image_url", image_url: { url: dataUrl } },
  ] }];
  let lastErr;
  for (const model of VISION_MODELS) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = { model, messages, max_tokens: VISION_MAX_TOKENS };
      try {
        const res = await fetch(`${VISION_BASE}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${VISION_API_KEY}` },
          body: JSON.stringify(body),
        });
        if (res.status === 429) {
          lastErr = new Error(`${model} 429`);
          await sleep(8000 + Math.floor(Math.random() * 2000));
          continue;
        }
        const raw = await res.text();
        if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${raw.slice(0, 200)}`);
        const content = JSON.parse(raw)?.choices?.[0]?.message?.content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((b) => b?.type === "text").map((b) => b.text).join("")
            : "";
        if (text && text.trim()) return { text: text.trim(), model };
        throw new Error(`${model} empty reply`);
      } catch (err) {
        lastErr = err;
        if (String(err?.message).includes("429")) continue;
        await sleep(2000 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error("DeepSeek vision failed");
}

function runCodex(promptText) {
  const replyFile = path.join(STATE_DIR, "recover-reply.txt");
  if (fs.existsSync(replyFile)) fs.unlinkSync(replyFile);
  const env = { ...process.env };
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  const args = ["exec", "resume", sessionId, "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", "notify=[]", "--json", "-o", replyFile, "-"];
  const child = spawn(CODEX_NODE, [CODEX_CLI, ...args], { stdio: ["pipe", "pipe", "ignore"], env, windowsHide: true });
  let lastText = "";
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("{")) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text?.trim()) {
          lastText = ev.item.text;
        }
      } catch {}
    }
  });
  child.stdin.write(promptText + "\n");
  child.stdin.end();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); }, 600000);
    child.on("close", () => {
      clearTimeout(timer);
      let text = lastText;
      if (!text && fs.existsSync(replyFile)) text = fs.readFileSync(replyFile, "utf-8").trim();
      resolve(text || "");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function sendMessage(text) {
  const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
  const res = await fetch(`${account.baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${account.token}`,
      "X-WECHAT-UIN": uin,
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff)),
    },
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: target,
        client_id: `recover:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: ctxToken,
        run_id: `recover-${crypto.randomUUID()}`,
      },
      base_info: { channel_version: "2.4.6", bot_agent: "Codex/1.0" },
    }),
  });
  const raw = await res.text();
  console.log("sendmessage HTTP", res.status, raw.slice(0, 200));
}

const mediaType = "image/jpeg";
const buffer = fs.readFileSync(imagePath);
const r = await transcribe(buffer, mediaType);
console.log("transcript model=", r.model, "len=", r.text.length);
const reply = await runCodex(
  "用户之前发来一张图片(图片识别刚恢复),内容转录如下:\n\n" + r.text + "\n\n请结合图片内容直接回应用户。",
);
console.log("reply len=", reply.length);
if (reply) await sendMessage(reply);
else console.error("empty reply; nothing sent");
