#!/usr/bin/env node
//
// Boots the built MCP server over stdio, performs the MCP handshake, and
// verifies the expected tools are exposed. Exit code: 0 = healthy,
// 1 = booted but tools missing/incomplete, 2 = could not start.
//
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "..", "dist", "index.js");

const REQUIRED = [
  "list_files",
  "get_document",
  "execute_code",
  "sync_nodes",
  "save_version",
  "create_file",
  "duplicate_file",
  "list_account_files",
  "delete_file",
  "pull_latest",
];

if (!fs.existsSync(SERVER)) {
  console.error(`FAIL: ${SERVER} not found — run the build first (npm run build in server/).`);
  process.exit(2);
}

const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
proc.on("error", (e) => {
  console.error("FAIL: could not start server:", e.message);
  process.exit(2);
});

let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    } catch {
      /* ignore non-JSON log lines */
    }
  }
});

const send = (m) => proc.stdin.write(JSON.stringify(m) + "\n");
const req = (id, method, params) =>
  new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    send({ jsonrpc: "2.0", id, method, params });
  });

try {
  await req(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "healthcheck", version: "1.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = await req(2, "tools/list", {});
  const names = new Set((tools.result?.tools ?? []).map((t) => t.name));
  const missing = REQUIRED.filter((t) => !names.has(t));
  console.log(`Server booted and exposed ${names.size} tools.`);
  proc.kill("SIGTERM");
  if (missing.length) {
    console.error(`FAIL: missing expected tools: ${missing.join(", ")}`);
    console.error("The build may be stale — re-run: npm run build (in server/).");
    process.exit(1);
  }
  console.log("OK: all required tools present, including pull_latest.");
  process.exit(0);
} catch (e) {
  console.error("FAIL:", e.message);
  proc.kill("SIGTERM");
  process.exit(1);
}
