// Newline-delimited JSON-RPC 2.0 endpoint over a readable/writable stream pair.
// Used for both sides of this server: the MCP connection to Claude Code
// (process.stdin/stdout) and the client connection to the codex app-server
// child process. Both speak JSONL framing (no Content-Length headers).
// Tolerates peers that omit the "jsonrpc" field (codex app-server does).

import { createInterface } from "node:readline";

export class JsonRpcEndpoint {
  constructor(readable, writable, { name = "rpc" } = {}) {
    this.writable = writable;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, method}
    this.requestHandlers = new Map(); // method -> async (params, id) => result
    this.notificationHandlers = new Map(); // method -> (params) => void
    this.anyNotificationHandler = null; // (method, params) => void
    this.rl = createInterface({ input: readable, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.#onLine(line));
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[${this.name}] ignoring non-JSON line: ${trimmed.slice(0, 200)}\n`);
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg.method !== undefined && msg.id !== undefined) {
      this.#dispatchRequest(msg);
    } else if (msg.method !== undefined) {
      this.#dispatchNotification(msg);
    } else if (msg.id !== undefined) {
      this.#dispatchResponse(msg);
    }
  }

  async #dispatchRequest(msg) {
    const handler = this.requestHandlers.get(msg.method);
    if (!handler) {
      this.#write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }
    try {
      const result = await handler(msg.params, msg.id);
      this.#write({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
    } catch (err) {
      this.#write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: err?.code ?? -32603, message: String(err?.message ?? err) },
      });
    }
  }

  #dispatchNotification(msg) {
    const handler = this.notificationHandlers.get(msg.method);
    try {
      if (handler) handler(msg.params);
      if (this.anyNotificationHandler) this.anyNotificationHandler(msg.method, msg.params);
    } catch (err) {
      process.stderr.write(`[${this.name}] notification handler error (${msg.method}): ${err?.stack ?? err}\n`);
    }
  }

  #dispatchResponse(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.error !== undefined && msg.error !== null) {
      const err = new Error(`${entry.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
      err.code = msg.error.code;
      err.data = msg.error.data;
      entry.reject(err);
    } else {
      entry.resolve(msg.result);
    }
  }

  #write(obj) {
    try {
      this.writable.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      process.stderr.write(`[${this.name}] write failed: ${err?.message ?? err}\n`);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  onAnyNotification(handler) {
    this.anyNotificationHandler = handler;
  }

  failAllPending(err) {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }
}
