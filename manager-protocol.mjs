export function parseManagerDecision(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(),
  ];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") continue;
      const action = String(parsed.action || "reply").toLowerCase();
      if (!["reply", "dispatch", "cancel"].includes(action)) continue;
      return {
        action,
        reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
        task: typeof parsed.task === "string" ? parsed.task.trim() : "",
        jobId: typeof parsed.job_id === "string" ? parsed.job_id.trim() : "",
      };
    } catch {}
  }

  // Schema enforcement can still fall back to prose during a provider issue.
  // Treat that prose as a direct manager reply rather than losing the turn.
  return { action: "reply", reply: text, task: "", jobId: "" };
}
