import test from "node:test";
import assert from "node:assert/strict";
import { extractMediaDirectives } from "../directives.mjs";

test("extracts a single image directive and keeps surrounding text", () => {
  const r = extractMediaDirectives("给你看看\n[[send-image: C:\\a\\b.png]]\n好看吗");
  assert.deepEqual(r.media, [{ kind: "image", path: "C:\\a\\b.png" }]);
  assert.equal(r.text, "给你看看\n好看吗");
});

test("supports video + file, multiple directives, case-insensitive", () => {
  const r = extractMediaDirectives("[[SEND-VIDEO: /tmp/v.mp4]]\n[[send-file: /tmp/z.zip]]");
  assert.deepEqual(r.media, [
    { kind: "video", path: "/tmp/v.mp4" },
    { kind: "file", path: "/tmp/z.zip" },
  ]);
  assert.equal(r.text, "");
});

test("ignores directives that are not on their own line", () => {
  const r = extractMediaDirectives("看这个 [[send-image: /a.png]] 行不行");
  assert.equal(r.media.length, 0);
  assert.equal(r.text, "看这个 [[send-image: /a.png]] 行不行");
});

test("handles null and empty input", () => {
  assert.deepEqual(extractMediaDirectives(null), { media: [], text: "" });
  assert.deepEqual(extractMediaDirectives(""), { media: [], text: "" });
});

test("strips only directive lines and trims the result", () => {
  const r = extractMediaDirectives("\n\n[[send-image: /a.png]]\n正文\n\n");
  assert.equal(r.media.length, 1);
  assert.equal(r.text, "正文");
});
