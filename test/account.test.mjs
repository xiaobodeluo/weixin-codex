import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  extractOption,
  maskIdentifier,
  resolveFromScript,
} from "../weixin-account.mjs";

test("extractOption removes a target argument", () => {
  const argv = ["--to", "user-123", "--text", "hello"];
  assert.equal(extractOption(argv, "to"), "user-123");
  assert.deepEqual(argv, ["--text", "hello"]);
});

test("extractOption rejects a missing value", () => {
  assert.throws(() => extractOption(["--to"], "to"), /requires a value/);
});

test("maskIdentifier does not expose short or long ids", () => {
  assert.equal(maskIdentifier("12345678"), "***");
  assert.equal(maskIdentifier("abcdefghijk"), "abcd...hijk");
  assert.equal(maskIdentifier(""), "none");
});

test("resolveFromScript resolves relative paths", () => {
  assert.match(resolveFromScript("data"), /data$/);
  assert.equal(path.isAbsolute(resolveFromScript("data")), true);
});
