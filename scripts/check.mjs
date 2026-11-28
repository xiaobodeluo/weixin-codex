import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set([".git", "node_modules", "state", "work", "outputs", "vendor"]);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push(full);
  }
}

walk(root);

for (const file of files.filter((item) => item.endsWith(".mjs"))) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of files.filter((item) => item.endsWith(".json"))) {
  JSON.parse(fs.readFileSync(file, "utf-8"));
}

console.log(`syntax and JSON checks passed (${files.length} files)`);
