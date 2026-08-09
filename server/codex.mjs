// Manages a single persistent `codex app-server` child process and multiplexes
// threads/turns over its JSONL JSON-RPC stdio interface.

import { spawn } from "node:child_process";
import { JsonRpcEndpoint } from "./jsonrpc.mjs";
import { locateCodex } from "./locate-codex.mjs";

const CLIENT_VERSION = "0.1.0";

// Server->client approval requests, auto-denied. Under approvalPolicy "never"
// none of these should ever arrive; deny defensively so a turn can never hang
// waiting on a human. v2 methods take {decision}, legacy v1 methods too but
// with a different enum.
const DENY_METHODS = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": { decision: "decline" },
  "execCommandApproval": { decision: "denied" },
  "applyPatchApproval": { decision: "denied" },
};

export class CodexAppServer {
  constructor() {
    this.child = null;
    this.rpc = null;
    this.startPromise = null;
    this.modelsCache = null;
    this.exePath = null;
    this.collectors = new Map(); // threadId -> in-flight turn collector
  }

  ensureStarted() {
    if (!this.startPromise) {
      this.startPromise = this.#start().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  async #start() {
    this.exePath = locateCodex();
    const child = spawn(this.exePath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (d) => process.stderr.write(`[codex] ${d}`));

    const rpc = new JsonRpcEndpoint(child.stdout, child.stdin, { name: "codex" });

    for (const [method, response] of Object.entries(DENY_METHODS)) {
      rpc.onRequest(method, async () => response);
    }
    rpc.onRequest("item/tool/requestUserInput", async () => {
      throw new Error("codex-subagent runs unattended; user input is unavailable");
    });

    rpc.onAnyNotification((method, params) => this.#onNotification(method, params));

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      const reason = new Error(
        `codex app-server exited (${signal ?? `code ${code}`}); call again to restart — non-ephemeral threads survive via threadId`
      );
      rpc.failAllPending(reason);
      for (const collector of this.collectors.values()) collector.reject(reason);
      this.collectors.clear();
      this.child = null;
      this.rpc = null;
      this.startPromise = null;
    });

    this.child = child;
    this.rpc = rpc;

    await rpc.request("initialize", {
      clientInfo: { name: "codex-subagent", title: "Claude Code Codex Subagent", version: CLIENT_VERSION },
      capabilities: {},
    });
    rpc.notify("initialized");
  }

  #onNotification(method, params) {
    const collector = params?.threadId && this.collectors.get(params.threadId);
    if (!collector) return;
    switch (method) {
      case "item/completed":
        if (params.item?.type === "agentMessage") collector.lastAgentMessage = params.item.text;
        break;
      case "thread/tokenUsage/updated":
        collector.usage = params.tokenUsage;
        break;
      case "turn/completed": {
        const turn = params.turn ?? {};
        if (turn.status === "failed") {
          const detail = turn.error?.message ?? JSON.stringify(turn.error ?? {});
          collector.reject(new Error(`codex turn failed: ${detail}`));
        } else {
          collector.finish(turn.status ?? "completed");
        }
        break;
      }
      case "error":
        collector.lastError = params.message ?? params.error?.message ?? JSON.stringify(params);
        break;
    }
  }

  async listModels() {
    await this.ensureStarted();
    if (!this.modelsCache) {
      const res = await this.rpc.request("model/list", { limit: 100 });
      this.modelsCache = res?.data ?? [];
    }
    return this.modelsCache;
  }

  async authStatus() {
    await this.ensureStarted();
    return this.rpc.request("getAuthStatus", { includeToken: false, refreshToken: false });
  }

  // opts: {prompt, model, effort, instructions, cwd, sandbox, ephemeral, threadId}
  // track: mutable object; track.threadId is set as soon as the thread is known
  // so the MCP layer can route cancellation to turn/interrupt.
  async runTurn(opts, track = {}) {
    await this.ensureStarted();

    let threadId = opts.threadId;
    let threadInfo = null;
    if (threadId) {
      if (this.collectors.has(threadId)) {
        throw new Error(`a turn is already in flight on thread ${threadId}`);
      }
      threadInfo = await this.rpc.request("thread/resume", {
        threadId,
        cwd: opts.cwd,
        sandbox: opts.sandbox,
        approvalPolicy: "never",
      });
    } else {
      threadInfo = await this.rpc.request("thread/start", {
        model: opts.model,
        cwd: opts.cwd,
        approvalPolicy: "never",
        sandbox: opts.sandbox ?? "workspace-write",
        ephemeral: opts.ephemeral ?? false,
        developerInstructions: opts.instructions,
      });
      threadId = threadInfo?.thread?.id;
      if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(threadInfo)}`);
    }
    track.threadId = threadId;

    const collector = { lastAgentMessage: null, usage: null, lastError: null, turnId: null };
    const done = new Promise((resolve, reject) => {
      collector.finish = (status) => resolve(status);
      collector.reject = reject;
    });
    this.collectors.set(threadId, collector);

    try {
      const turnRes = await this.rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: opts.prompt, text_elements: [] }],
        model: opts.model,
        effort: opts.effort,
        approvalPolicy: "never",
      });
      collector.turnId = turnRes?.turn?.id ?? null;
      const status = await done;
      return {
        text: collector.lastAgentMessage ?? "",
        status,
        threadId,
        usage: collector.usage,
        model: opts.model ?? threadInfo?.model ?? null,
        effort: opts.effort ?? threadInfo?.reasoningEffort ?? null,
      };
    } finally {
      this.collectors.delete(threadId);
    }
  }

  async interrupt(threadId) {
    const collector = this.collectors.get(threadId);
    if (!collector || !this.rpc) return;
    await this.rpc.request("turn/interrupt", { threadId, turnId: collector.turnId });
  }

  isAlive() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  shutdown() {
    if (this.child) this.child.kill();
  }
}
