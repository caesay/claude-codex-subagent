#!/usr/bin/env node
// MCP stdio server entry point. Speaks JSONL JSON-RPC 2.0 on stdin/stdout to
// Claude Code and proxies tool calls to a persistent codex app-server child.

import { JsonRpcEndpoint } from "./jsonrpc.mjs";
import { CodexAppServer } from "./codex.mjs";
import { TOOLS, callTool } from "./tools.mjs";

const SERVER_VERSION = "0.1.0";

const codex = new CodexAppServer();
const mcp = new JsonRpcEndpoint(process.stdin, process.stdout, { name: "mcp" });

// MCP request id -> mutable track object ({threadId}) for cancellation routing.
const inflight = new Map();

mcp.onRequest("initialize", async (params) => ({
  protocolVersion: params?.protocolVersion ?? "2024-11-05",
  capabilities: { tools: {} },
  serverInfo: { name: "codex-subagent", version: SERVER_VERSION },
}));

mcp.onNotification("notifications/initialized", () => {});

mcp.onRequest("ping", async () => ({}));

mcp.onRequest("tools/list", async () => ({ tools: TOOLS }));

mcp.onRequest("tools/call", async (params, id) => {
  const track = {};
  inflight.set(id, track);
  try {
    return await callTool(codex, params?.name, params?.arguments ?? {}, track);
  } catch (err) {
    // Tool failures are results with isError, never protocol errors.
    return {
      content: [{ type: "text", text: String(err?.message ?? err) }],
      isError: true,
    };
  } finally {
    inflight.delete(id);
  }
});

mcp.onNotification("notifications/cancelled", (params) => {
  const track = inflight.get(params?.requestId);
  if (track?.threadId) {
    codex.interrupt(track.threadId).catch((err) => {
      process.stderr.write(`[mcp] interrupt failed: ${err?.message ?? err}\n`);
    });
  }
});

function shutdown() {
  codex.shutdown();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
// Codex app-server does not exit on stdin EOF alone, so a hard-killed parent
// orphans it. Catch what signals we can (POSIX; Windows kills are unhookable).
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
