import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_INSTRUCTION =
  "一位安静、温柔、声音清楚的年轻女性，语速稍慢，表达克制，像在认真陪人说话，不像客服或新闻播报。";
const DEFAULT_CHANNEL_VERSION = "2.4.6";
const DEFAULT_BOT_AGENT = "Codex/1.0";

export function cleanSpeechText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, "（代码已省略。）")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "链接")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitSpeechText(text, maxChars) {
  const normalized = cleanSpeechText(text).replace(/\n+/g, "。");
  if (!normalized) return [];
  const limit = Math.max(40, Number(maxChars) || 220);
  const sentences = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [normalized];
  const chunks = [];
  let current = "";

  const pushLongPiece = (piece) => {
    let rest = piece;
    while (rest.length > limit) {
      const slice = rest.slice(0, limit);
      const breakAt = Math.max(
        slice.lastIndexOf("，"),
        slice.lastIndexOf(","),
        slice.lastIndexOf(" "),
      );
      const cut = breakAt >= Math.floor(limit * 0.55) ? breakAt + 1 : limit;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
  };

  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    if (sentence.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      pushLongPiece(sentence);
    } else if (!current || current.length + sentence.length <= limit) {
      current += sentence;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function wavFromPcm(pcm, sampleRate) {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function readPcm16MonoWav(wav) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Expected a PCM WAV file");
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) break;
    if (id === "fmt " && size >= 16) {
      format = {
        code: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new Error("WAV file is missing fmt/data chunks");
  if (format.code !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error(
      `Unsupported WAV format code=${format.code} channels=${format.channels} bits=${format.bitsPerSample}`,
    );
  }
  return { pcm: data, sampleRate: format.sampleRate };
}

function resamplePcm16Mono(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inputSamples = Math.floor(pcm.length / 2);
  const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i += 1) {
    const sourceIndex = (i * fromRate) / toRate;
    const leftIndex = Math.min(inputSamples - 1, Math.floor(sourceIndex));
    const rightIndex = Math.min(inputSamples - 1, leftIndex + 1);
    const fraction = sourceIndex - leftIndex;
    const left = pcm.readInt16LE(leftIndex * 2);
    const right = pcm.readInt16LE(rightIndex * 2);
    output.writeInt16LE(Math.round(left + (right - left) * fraction), i * 2);
  }
  return output;
}

export async function synthesizeBreeze({ text, config, outputDir }) {
  const endpoint = String(config.endpoint || "").trim();
  if (!endpoint) throw new Error("Breeze TTS endpoint is not configured");

  const sampleRate = Number(config.sampleRate) || 24000;
  const form = new FormData();
  form.set("text", text);
  form.set("instruction", config.instruction || DEFAULT_INSTRUCTION);
  if (config.cfgScale != null) form.set("cfg_scale", String(config.cfgScale));
  if (config.seed != null) form.set("seed", String(config.seed));

  const headers = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const timeoutMs = Math.max(10000, Number(config.timeoutMs) || 120000);
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Breeze TTS HTTP ${res.status}: ${detail}`);
  }

  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length) throw new Error("Breeze TTS returned empty audio");
  const wav =
    body.length >= 12 && body.toString("ascii", 0, 4) === "RIFF"
      ? body
      : wavFromPcm(body, sampleRate);
  fs.mkdirSync(outputDir, { recursive: true });
  const stem = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const wavPath = path.join(outputDir, `${stem}.wav`);
  fs.writeFileSync(wavPath, wav);
  return { wavPath, sampleRate, bytes: wav.length };
}

export async function encodeWavToSilk({ wavPath, config, outputDir }) {
  const modulePath =
    config.silkModule ||
    path.join(SCRIPT_DIR, "vendor", "silk-wasm", "lib", "index.mjs");
  const { encode } = await import(pathToFileURL(modulePath).href);
  const wav = fs.readFileSync(wavPath);
  const source = readPcm16MonoWav(wav);
  const targetRate = Number(config.voiceSampleRate) || 16000;
  const pcm = resamplePcm16Mono(source.pcm, source.sampleRate, targetRate);
  const normalizedWav = wavFromPcm(pcm, targetRate);
  const encoded = await encode(normalizedWav, targetRate);
  const silkPath = path.join(
    outputDir,
    `${path.basename(wavPath, path.extname(wavPath))}.silk`,
  );
  fs.writeFileSync(silkPath, encoded.data);
  return {
    silkPath,
    durationMs: Math.round(encoded.duration),
    sampleRate: targetRate,
  };
}

function wechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function aesEcbPaddedSize(plainSize) {
  return Math.ceil((plainSize + 1) / 16) * 16;
}

export async function sendWeixinVoiceFile({
  account,
  to,
  ctxToken,
  silkPath,
  durationMs,
  sampleRate = 16000,
  text = "",
  channelVersion = DEFAULT_CHANNEL_VERSION,
  botAgent = DEFAULT_BOT_AGENT,
}) {
  const { token, baseUrl } = account;
  const baseInfo = { channel_version: channelVersion, bot_agent: botAgent };
  const redact = (value) => String(value).replaceAll(token || "___", "***TOKEN***");
  const [major = 0, minor = 0, patch = 0] = String(channelVersion)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const clientVersion = ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);

  const wxPost = async (endpoint, body, timeoutMs = 30000) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${token}`,
        "X-WECHAT-UIN": wechatUin(),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String(clientVersion),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(
        `wx ${endpoint} HTTP ${res.status}: ${redact(raw).slice(0, 400)}`,
      );
    }
    return JSON.parse(raw);
  };

  const plaintext = fs.readFileSync(silkPath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await wxPost("ilink/bot/getuploadurl", {
    filekey,
    media_type: 4, // VOICE
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
        signal: AbortSignal.timeout(30000),
      });
      if (res.status !== 200) {
        const detail = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN HTTP ${res.status}: ${redact(detail).slice(0, 300)}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN response missing x-encrypted-param header");
      }
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error("CDN upload failed after 3 attempts");
  }

  const clientId = `weixin-codex:${Date.now()}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  const voiceItem = {
    type: 3,
    voice_item: {
      media: {
        encrypt_query_param: downloadParam,
        aes_key: Buffer.from(aeskey.toString("hex"), "ascii").toString("base64"),
      },
      encode_type: 4,
      bits_per_sample: 16,
      sample_rate: sampleRate,
      playtime: Math.max(1, Math.round(durationMs)),
    },
  };
  const resp = await wxPost("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [voiceItem],
      context_token: ctxToken,
      run_id: `codex-${crypto.randomUUID()}`,
    },
    base_info: baseInfo,
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
  return { clientId, bytes: rawsize, durationMs, filekey };
}

export async function sendBreezeVoiceReply({
  account,
  to,
  ctxToken,
  replyText,
  config,
  outputDir,
}) {
  if (!config?.enabled) return { sent: 0, skipped: "disabled" };
  const chunks = splitSpeechText(replyText, config.maxCharsPerMessage || 220);
  if (!chunks.length) return { sent: 0, skipped: "empty" };
  const maxVoiceMessages = Math.max(1, Number(config.maxVoiceMessages) || 3);
  if (chunks.length > maxVoiceMessages) {
    return { sent: 0, skipped: "too-long", chunks: chunks.length };
  }

  let sent = 0;
  const files = [];
  for (const chunk of chunks) {
    const synthesized = await synthesizeBreeze({
      text: chunk,
      config,
      outputDir,
    });
    const encoded = await encodeWavToSilk({
      wavPath: synthesized.wavPath,
      config,
      outputDir,
    });
    const result = await sendWeixinVoiceFile({
      account,
      to,
      ctxToken,
      silkPath: encoded.silkPath,
      durationMs: encoded.durationMs,
      sampleRate: encoded.sampleRate,
      text: chunk,
      channelVersion: config.channelVersion,
      botAgent: config.botAgent,
    });
    sent += 1;
    files.push({
      wavPath: synthesized.wavPath,
      silkPath: encoded.silkPath,
      durationMs: encoded.durationMs,
      clientId: result.clientId,
    });
  }
  return { sent, files };
}
