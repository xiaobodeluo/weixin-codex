import test from "node:test";
import assert from "node:assert/strict";
import { parseManagerDecision } from "../manager-protocol.mjs";

test("parses a direct manager reply", () => {
  assert.deepEqual(
    parseManagerDecision(
      '{"action":"reply","reply":"我在。","task":"","job_id":""}',
    ),
    { action: "reply", reply: "我在。", task: "", jobId: "" },
  );
});

test("parses dispatch decisions from fenced JSON", () => {
  assert.deepEqual(
    parseManagerDecision(
      '```json\n{"action":"dispatch","reply":"我安排。","task":"检查天气","job_id":""}\n```',
    ),
    {
      action: "dispatch",
      reply: "我安排。",
      task: "检查天气",
      jobId: "",
    },
  );
});

test("normalizes cancel job ids", () => {
  assert.deepEqual(
    parseManagerDecision(
      '{"action":"cancel","reply":"好。","task":"","job_id":" #74ca8c "}',
    ),
    { action: "cancel", reply: "好。", task: "", jobId: "#74ca8c" },
  );
});

test("falls back to prose when schema enforcement is bypassed", () => {
  assert.deepEqual(parseManagerDecision("主管直接回复"), {
    action: "reply",
    reply: "主管直接回复",
    task: "",
    jobId: "",
  });
});

test("rejects empty output", () => {
  assert.equal(parseManagerDecision(""), null);
});
