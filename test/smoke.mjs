// Smoke test: drives server/index.mjs over raw JSONL stdio, no Claude needed.
// Usage: node test/smoke.mjs [--no-turn]   (--no-turn skips the live CodexAgent call)

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skipTurn = process.argv.includes("--no-turn");

const child = spawn(process.execPath, [join(root, "server", "index.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let nextId = 1;

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error("non-JSON line from server:", line.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else resolve(msg.result);
  }
});

function request(method, params, timeoutMs = 30_000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method} (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function assert(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`ok: ${label}`);
}

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "smoke", version: "0.0.1" },
    capabilities: {},
  });
  assert(init.serverInfo?.name === "codex-subagent", "initialize returns serverInfo");
  assert(init.protocolVersion === "2024-11-05", "initialize echoes protocolVersion");
  notify("notifications/initialized");

  const tools = await request("tools/list", {});
  assert(tools.tools?.length === 2, "tools/list returns 2 tools");
  assert(
    tools.tools.map((t) => t.name).sort().join(",") === "CodexAgent,CodexStatus",
    "tool names are CodexAgent, CodexStatus"
  );

  const status = await request("tools/call", { name: "CodexStatus", arguments: {} }, 60_000);
  assert(!status.isError, "CodexStatus succeeds");
  const s = status.structuredContent;
  assert(s?.exePath, "CodexStatus reports exe path");
  assert(Array.isArray(s?.models) && s.models.length > 0, "CodexStatus reports models");
  assert(s?.serverRunning === true, "app-server child is running");
  console.log("  default model:", s.models.find((m) => m.isDefault)?.id);
  console.log("  auth:", JSON.stringify(s.auth).slice(0, 200));

  if (!skipTurn) {
    console.log("running CodexAgent turn (may take a minute)...");
    const agent = await request(
      "tools/call",
      {
        name: "CodexAgent",
        arguments: {
          prompt: "Reply with exactly: PONG",
          sandbox: "read-only",
          effort: "low",
          ephemeral: true,
          cwd: root,
        },
      },
      300_000
    );
    assert(!agent.isError, "CodexAgent succeeds");
    const text = agent.content?.[0]?.text ?? "";
    assert(text.includes("PONG"), "CodexAgent output contains PONG");
    assert(text.includes("---codex---"), "result has ---codex--- footer");
    assert(/threadId: \S+/.test(text), "footer has threadId");
    assert(agent.structuredContent?.status === "completed", "structuredContent status completed");
    console.log("  turn result:\n" + text.split("\n").map((l) => "    " + l).join("\n"));
  }

  console.log("\nSMOKE PASS");
  child.kill();
  process.exit(0);
} catch (err) {
  console.error("\nSMOKE FAIL:", err.message);
  child.kill();
  process.exit(1);
}
