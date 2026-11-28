#!/usr/bin/env node
// Send a plain text message to the WeChat user via the iLink bot protocol.
// usage: node send-text.mjs [--to <id>] <text-file>
//        node send-text.mjs [--to <id>] --text "hello"
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  extractOption,
  resolveWeixinAccount,
} from "./weixin-account.mjs";

const CHUNK = 1900;

const args = process.argv.slice(2);
const toArg = extractOption(args, "to");
let text = "";
const textIndex = args.indexOf("--text");
if (textIndex >= 0) {
  text = args.slice(textIndex + 1).join(" ");
} else if (args[0] && fs.existsSync(args[0])) {
  text = fs.readFileSync(path.resolve(args[0]), "utf-8").trim();
} else {
  console.error("usage: node send-text.mjs [--to <id>] <text-file> | --text \"...\"");
  process.exit(2);
}
if (!text) {
  console.error("empty text");
  process.exit(2);
}

const session = resolveWeixinAccount({ target: toArg });
const { to, contextToken: ctxToken, account } = session;
const { token, baseUrl } = account;
const baseInfo = { channel_version: "2.4.6", bot_agent: "Codex/1.0" };

function headers() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": Buffer.from(String(uint32), "utf-8").toString("base64"),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff)),
  };
}

async function sendMessage(part) {
  const clientId = `weixin-codex:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: part } }],
        context_token: ctxToken,
        run_id: `codex-${crypto.randomUUID()}`,
      },
      base_info: baseInfo,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`sendmessage HTTP ${res.status}: ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  if (j.ret && j.ret !== 0) throw new Error(`sendmessage ret=${j.ret} errmsg=${j.errmsg ?? ""}`);
  return clientId;
}

let sent = 0;
for (let i = 0; i < text.length; i += CHUNK) {
  const id = await sendMessage(text.slice(i, i + CHUNK));
  sent += 1;
  console.log(`sent part ${sent} clientId=${id}`);
}
console.log(`done, ${sent} message(s), ${text.length} chars`);
