import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseManagerDecision } from "./manager-protocol.mjs";

function matchTomlString(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]+)"\\s*$`, "m"),
  );
  return match ? match[1] : "";
}

function readCodexProvider(codexHome) {
  const file = path.join(codexHome, "config.toml");
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const model = matchTomlString(raw, "model");
    const providerName = matchTomlString(raw, "model_provider");
    if (!providerName) return { model };
    const lines = raw.split(/\r?\n/);
    const sectionHeader = `[model_providers.${providerName}]`;
    const start = lines.findIndex((line) => line.trim() === sectionHeader);
    let end = start + 1;
    while (start >= 0 && end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
    const body = start >= 0 ? lines.slice(start + 1, end).join("\n") : "";
    return {
      model,
      providerName,
      baseUrl: matchTomlString(body, "base_url"),
      apiKey:
        matchTomlString(body, "experimental_bearer_token") ||
        matchTomlString(body, "api_key"),
    };
  } catch {
    return {};
  }
}

export function resolveManagerApi(cfg = {}, codexHome = "") {
  const managerCfg =
    cfg.managerApi && typeof cfg.managerApi === "object" ? cfg.managerApi : {};
  if (managerCfg.mode === "off" || managerCfg.enabled === false) {
    return { enabled: false, reason: "disabled" };
  }

  const home =
    codexHome ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex");
  const provider = readCodexProvider(home);
  const model = managerCfg.model || provider.model || "deepseek-flash";
  const baseUrl =
    managerCfg.baseUrl ||
    process.env.DEEPSEEK_BASE_URL ||
    provider.baseUrl ||
    "https://api.deepseek.com/v1";
  const apiKey =
    managerCfg.apiKey ||
    process.env.DEEPSEEK_API_KEY ||
    provider.apiKey ||
    "";

  if (!apiKey) return { enabled: false, reason: "no-api-key", model, baseUrl };
  return {
    enabled: true,
    model,
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    timeoutMs: Number(managerCfg.timeoutMs) || 30000,
  };
}

function managerSystemPrompt() {
  return [
    "你是微信里的 Codex 主管。只负责沟通、判断、拆解、派活、追踪和汇总。",
    "不要亲自执行任务，不要把同一件事重复派工。",
    "严格返回一个 JSON 对象，字段为 action、reply、task、job_id。",
    'action 只能是 "reply"、"dispatch"、"cancel"。',
    "dispatch 时 task 必须自包含；cancel 时 job_id 填任务编号；未使用字段填空字符串。",
    "普通聊天、进度追问、确认和已有结果能回答的问题一律 reply。",
    "已有运行中任务或最近几分钟的结果已经满足请求时，不得重复 dispatch。",
  ].join("\n");
}

async function postManager({
  provider,
  messages,
  useResponseFormat,
  fetchImpl,
}) {
  const body = {
    model: provider.model,
    messages,
    temperature: 0.1,
    max_tokens: 1200,
  };
  if (useResponseFormat) body.response_format = { type: "json_object" };
  const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(provider.timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) {
    const error = new Error(`manager api HTTP ${res.status}`);
    error.status = res.status;
    error.body = raw.slice(0, 500);
    throw error;
  }
  const parsed = JSON.parse(raw);
  const content = parsed?.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((item) => item?.type === "text").map((item) => item.text).join("")
        : "";
  if (!text.trim()) throw new Error("manager api returned empty content");
  return text.trim();
}

export async function requestManagerDecision({
  provider,
  prompt,
  historyUserText = prompt,
  history = [],
  fetchImpl = fetch,
}) {
  if (!provider?.enabled) throw new Error("direct manager is not configured");
  const messages = [
    { role: "system", content: managerSystemPrompt() },
    ...history,
    { role: "user", content: String(prompt || "") },
  ];
  const startedAt = Date.now();
  let raw;
  try {
    raw = await postManager({ provider, messages, useResponseFormat: true, fetchImpl });
  } catch (err) {
    if (err?.status !== 400) throw err;
    raw = await postManager({ provider, messages, useResponseFormat: false, fetchImpl });
  }
  const decision = parseManagerDecision(raw);
  if (!decision) throw new Error("manager api returned an empty decision");
  return {
    decision,
    raw,
    history: [
      ...history,
      { role: "user", content: String(historyUserText || "") },
      { role: "assistant", content: raw },
    ],
    latencyMs: Date.now() - startedAt,
  };
}
